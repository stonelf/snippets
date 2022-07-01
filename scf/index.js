'use strict';
const Database = require('better-sqlite3'),
	COS = require('cos-nodejs-sdk-v5'),
	cos = new COS({SecretId: process.env.SECRET_ID,SecretKey: process.env.SECRET_KEY,KeepAlive: false}),
	JSZIP = require("jszip"),
	dbPath = '/mnt/demos.db',
	db = new Database(dbPath, {}),
	sql = `select 
	action.ProductName as productNameCN,
	action.Product as productName,
	SdkDemo.Language as lang,
	action.Description as desc,
	DemoJsonCode as code,
	action.Action as action
	from SdkDemo,action
	where action.Product=SdkDemo.ProductName
	and SdkDemo.ProductAction=action.Action	`,
	vsCodeScopeDict = { "nodejs": "javascript,typescript", "GO": "go", "PHP": "php", "Java": "java", "Python": "python", "cpp": "cpp", "dotnet": "dotnet" },
	ideaLanguageDict = { "Java": "java","nodejs":"javascript"},
	sublimeScopeDict = {"Java":"source.java","nodejs":"source.js","GO":"source.go","PHP":"source.php","Python":"source.python","cpp":"source.c++"},
	snippets = {"vscode":{},"idea":{},"sublime":{}};
	Object.keys(vsCodeScopeDict).forEach(lang => {
		snippets["vscode"][lang] = {};
	});
	Object.keys(ideaLanguageDict).forEach(lang => {
		snippets["idea"][lang] = [];
	});
	Object.keys(sublimeScopeDict).forEach(lang => {
		snippets["sublime"][lang] = {};
	});



async function saveCos(path, content) {
	return new Promise((res, rej) => {
		cos.putObject({
			Bucket: process.env.Bucket,
			Region: process.env.Region,
			Key: path,
			Body: content
		}, function (err, data) {
			if (err) {
				console.log("上传 " + path + " 失败")
				console.log(err)
				rej(err)
			} else {
				console.log("上传 " + path + " 成功")
				res(data.Location)
			}
		});
	})
}

function listObject(path) {
	return new Promise((res, rej) => {
		cos.getBucket({
			Bucket: process.env.Bucket,
			Region: process.env.Region,
			Prefix: path + '/', 
		}, function (err, data) {
			res(err ? [] : data.Contents);
		});
	})
}
function getSnippetsByProduct(p) {
	let result = db.prepare(sql + (p ? "and action.Product in ('" + p.join("','") + "')" : "")).all()
	return result;
}
function getPrefix(d){
	return (d.action + " " + d.desc.replace(/(本接口)|(用于)|([\[\{\(（][^\]\}\)）]*[\]\}\)）])|([，。](.|\r|\n)*$)/g, " ")
	.replace(d.action, " ").replace(/((查询)|(查看)|(获取)|(创建)|(修改)|(删除)|(将))/g, "$1 ") +
	" " + (d.productNameCN != d.productName ? d.productNameCN : "") + " " + d.productName).replace(/\s+/g, " ")
}
exports.main_handler = async (event, context) => {
	let body = JSON.parse(event.body);
	if (body.msg == "hello apigateway") {
		console.log("commit all 使用了api网关默认测试模板，替换成测试数据");
		body = { product: ["cos"] }
	} else {
		console.log("body=" + JSON.stringify(body))
	}
	let product = ("product" in body && body.product.length > 0) ? body.product.sort() : false
	let pkgName = (product ? product.join("-") : "all");
	let list = await listObject(pkgName);
	let result = {};
	if (list.length > 0) {
		list.forEach(t => {
			if(/.snippets$/.test(t.Key))
				result[t.Key.split(".")[1]+"(vscode)"] = t.Key;
			else if(/sublime/.test(t.Key))
				result[t.Key.split("/")[2]+"(Sublime Text)"]=t.Key
			else if(/.user.zip$/.test(t.Key))
				result[t.Key.split("/")[1]+"(ideaIntelliJ IDEA)"]=t.Key
			else{
				console.log(t.Key)
			}
		});
	} else {
		result = getSnippetsByProduct(product)
		result.forEach(d => {
			snippets["vscode"][d.lang][`${d.action}-${d.productName}`] = {
				"scope": vsCodeScopeDict[d.lang],
				"prefix": getPrefix(d),
				"body": [d.code],
				"description": d.desc
			}
		})
		result.forEach(d => {
			if(d.lang in ideaLanguageDict)
				snippets["idea"][d.lang].push(`<template name="${d.action}" value="${d.code.replace(/"/g,"&quot;")
				.replace(/\r/g,"&#10;").replace(/\n/g,"&#13;").replace(/>/g,"&gt;").replace(/</g,"&lt;")}" description="${d.desc
				.replace(/\r/g,"&#10;").replace(/\n/g,"&#13;").replace(/>/g,"&gt;").replace(/</g,"&lt;")}" 
				toReformat="true" toShortenFQNames="true"><context><option name="JAVA_DECLARATION" value="true" /></context></template>`)
		})
		/** sublime text要每个规则保存一个文件最后打包zip */
		result.forEach(d => {
			if(d.lang in sublimeScopeDict){
				snippets["sublime"][d.lang][d.action]=`<snippet>
					<content><![CDATA[${d.code}]]></content>
					<tabTrigger>${getPrefix(d)}</tabTrigger>
					<scope>${sublimeScopeDict[d.lang]}</scope>
					<description>${d.desc}</description>
					</snippet>`;
			}
		})
		result = {};
		let p1 = Object.keys(snippets["vscode"]).map(lang => saveCos(
			pkgName + "/vscode/" + pkgName + "." + lang + ".snippets"
			, JSON.stringify(snippets["vscode"][lang], null, "\t")
		).then(path => {
			result[lang+"(vscode)"] = path.replace(/^[^\/]*\//, "")
		}));
		let p2 = Object.keys(snippets["idea"]).map(lang=>{
			let zip = new JSZIP();
			zip.file("user.xml", '<templateSet group="user">'+snippets["idea"][lang].join("")+"</templateSet>");
			return  zip.generateAsync({type : "nodebuffer"}).then(content=>{
				return saveCos(pkgName + "/"+lang+"/user.zip",content).then(
					path => {
						result[lang+"(ideaIntelliJ IDEA)"] = path.replace(/^[^\/]*\//, "")
				})
			})
		});
		let p3= Object.keys(snippets["sublime"]).map(lang=>{
			let zip = new JSZIP();
			Object.keys(snippets["sublime"][lang]).map(action=>{
				zip.file(action+".sublime-snippet", snippets["sublime"][lang][action]);
			})
			return  zip.generateAsync({type : "nodebuffer"}).then(content=>{
				return saveCos(pkgName + "/sublime/"+lang+"/user.zip",content).then(
					path => {
						result[lang+"(Sublime Text)"] = path.replace(/^[^\/]*\//, "")
				})
			})
		});
		await Promise.all([...p1,...p2,...p3]).then(() => {
			console.log("ok")
		}).catch(e => {
			console.log(e)
			result = e;
		})
	}
	return result
};
