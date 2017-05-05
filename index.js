#!/usr/bin/env node --harmony
let program = require('commander'),
	inquirer = require('inquirer'),
	chalk = require('chalk'),
	fs = require('fs'),
	path = require('path'),
	propertiesParser = require('properties-parser'),
    expandHomeDir = require('expand-home-dir'),
    wskprops = propertiesParser.read(process.env.WSK_CONFIG_FILE || expandHomeDir('~/.wskprops')),
	owProps = {
		apihost: wskprops.APIHOST || 'openwhisk.ng.bluemix.net',
		api_key: wskprops.AUTH,
		namespace: wskprops.NAMESPACE || '_',
		ignore_certs: process.env.NODE_TLS_REJECT_UNAUTHORIZED == "0"
    },
    ow = require('openwhisk')(owProps),
    cheerio = require('cheerio');

const owURLfront = "https://openwhisk.ng.bluemix.net/api/v1/experimental/web/",
	  supportedExt = [".html", ".js", ".css"],
	  defaultEntry = "index.html";


program.option('-a, --act <action>', 'upload/delete')
	.option('-w, --websiteName <websiteName>', 'The name of your website.')
	.option('-p, --path <path>', 'The path to your website\'s root directory. Require when uploading a website.')
	.option('-e, --entry <fileName>', 'The entry HTML page of your website (default is '+defaultEntry+')')
	.option('-d, --debug', 'Print out debug logs.')
	.parse(process.argv);


if(program.act == undefined){
	// interactive mode
	log('Welcome to OpenWhisk Web Wizard (OWWW)');
	inquirer.prompt([{					
			type: 'list',
			name: 'actionList',
			message: 'Select what you\'d to do',
			choices: ['Upload a website', 'Remove a website']					 	
		},
	]).then(answer => {
		logDev(answer);
		if(answer.actionList == 'Upload a website'){		
			log('To use OWWW to upload a website, you need to put all your .html, .css and .js files in the same folder. When reference a css or js file in the html, you need to add a OWWW="true" attrbuite to the tag (e.g., <link rel="stylesheet" '+chalk.bold.yellow('OWWW="true"')+' href="style.css">).');
			inquirer.prompt([{type:'confirm', name:'confirm', message:'Are you ready to continue?', default:false}])
			.then(answer => {
				if(answer.confirm){
					inquirer.prompt([
						{type:'input', name:'websiteName', message:'The name of your website: '},				
						{type: 'input', name: 'path', message: 'The path to your website folder (no tab-autocompletion now, sorry): ', default:process.cwd()},
						{type:'input', name:'entry', message:'The entry HTML page of your website: ', default:defaultEntry},	
					]).then(answer => {
						uploadWebsite(answer.path, answer.websiteName);
					}).catch(catchHandler);
				}
				else{
					endCLI(0);
				}
			}).catch(catchHandler);
		}
		else{
			// remove
			inquirer.prompt([{type:'input', name:'websiteName', message:'Enter the name of your website: '}]).then(answer => {
				deleteWebsite(answer.websiteName);
			}).catch(catchHandler);
		}
		
	}).catch(err => logError(err));			
}
else{	
	// command line mode
	if(program.act == "delete"){
		deleteWebsite(program.websiteName);
	}
	else if(program.act == "upload"){
		uploadWebsite(program.path, program.websiteName, program.entry);
	}
	else{
		logError("Action needs to be either upload or delete.")
		endCLI(0);
	}
	
}

function log(msg){
	console.log(msg);
}
function logWarning(msg){
	console.log(chalk.bold.yellow('[Warning] '+msg));
}
function logError(err){
	console.log(chalk.bold.red('[Error] '+ err));
}
function catchHandler(err){
	logError(err); endCLI(1); 
}
function logDev(msg){
	if(program.debug){
		try{
			console.log(chalk.italic('[Dev] '+JSON.stringify(msg)));	
		}
		catch(e){
			console.log(chalk.italic('[Dev] '+msg));
		}

		return;
	}					
}
function endCLI(error){
	// error: 0 for success, 1 for error
	console.log(chalk.yellow('Goodbye.'));
	process.exit(error);
}	

function deleteWebsite(pkgName){
	if(pkgName == undefined){
		logError("You need to provide a website name."); endCLI(0);
	}
	ow.packages.get({packageName:pkgName}).then(r => {
		logDev(r);
		var names = [];
		r.actions.forEach(action => names.push(pkgName+"/"+action.name));
		ow.actions.delete(names).then(r => {
			ow.packages.delete(pkgName).then(r => {
				logDev(r); log('Website '+pkgName+' deleted.'); endCLI(0);
			}).catch(catchHandler);						
		}).catch(catchHandler);			
	}).catch(catchHandler);
}

function uploadWebsite(rootDir, name, entry){
	if(rootDir == undefined || name == undefined){
		logError("You need to provide a website name and a path to your local website."); endCLI(0);
	}

	if(entry == undefined) entry = defaultEntry;
	
	if(rootDir.substring(rootDir.length-1) != "/") rootDir += "/";
	// cureently only upload .html, .js and .css files
	log("Scanning the files...");
	Promise.all([readFileNameAsync(rootDir, supportedExt)])
	.then(values => {
		values = [].concat.apply([], values);
		var files = {}, isEntry = false;
		values.forEach(value => {
			if(value.name == entry)
				isEntry = true;
			files[value.path] = {name:value.name, type:value.type};
		});
		if(!isEntry){
			logError("There is no "+entry+" in this directory."); endCLI(0);
		}

		log("Reading the files...");

		var code = [];					   				   	
		Object.keys(files).forEach(path => {
			code.push(readFileAsync(path));
		});

		Promise.all(code).then(values => {
			values.forEach(value => {
				files[value.path].code = value.code;
			});

			logDev(files);

			Object.keys(files).forEach(key => {
				var o = files[key];
				if(o.type == ".html"){
					// look for all local file references - css and js
					let $ = cheerio.load(o.code);										
					$("link[OWWW='true']").attr("href", function(index, string){											
						return string.replace(".css", ".css.http");
					});
					$("script[OWWW='true']").attr("src", function(index, string){											
						return string.replace(".js", ".js.http");
					});
					$("a[OWWW='true']").attr("href", function(index, string){											
						return string.replace(".html", ".html.http");
					});

					o.code = $.html();					
				}
			});
			

			// create OW actions
			
			log("Uploading package...");

			ow.packages.update({packageName:name})
			.then(pkg => {
				logDev(pkg);

				log("Uploading actions...");
				var results = [];

				Object.keys(files).forEach(key => {
					var obj = {}, ext = files[key].type.substring(1), CT;
					
					if(ext == "js"){
						CT = "application/javascript";
					}
					else{
						CT = "text/"+ext;
					}

					if(ext == "html"){
						obj = {
							'headers':{
								'content-type': CT,
							},
							'body':files[key].code
							
						};
					}
					else{
						obj = {
							'headers':{
								'content-type': CT,
							},
							'body':files[key].code
							
						};
					}

					let actionObj = {
						exec:{
							kind: 'nodejs:6',
							code:'function main() {return '+JSON.stringify(obj)+';}'												
						},
						annotations: [{key:'web-export', value:true}]
					}

					logDev(actionObj);									
					//var n =files[key].name.substring(0, files[key].name.lastIndexOf(files[key].type));
					results.push(ow.actions.update({actionName: pkg.name+'/'+files[key].name, action:actionObj}));
				});

				Promise.all(results).then(r => {
					logDev(r);
					log("Website "+name+" uploaded.")
					log("URL: "+chalk.bold.underline(owURLfront+r[0].namespace+"/"+entry+".http"));
					endCLI(0);
				}).catch(catchHandler);
			})
			.catch(catchHandler);			
			
		}).catch(catchHandler);	
	})
	.catch(catchHandler);

}


function readFileAsync(filePath){
	return new Promise((resolve, reject) => {
		fs.readFile(filePath, 'utf8', function(err, data){
			if (err){													
				reject(err);										
			}
		  	else{
		  		log(chalk.bold.cyan(filePath));
		  		resolve({path: filePath, code: data});
		  	}							
		});
	});
}

function readFileNameAsync(dir, extArray){
	console.log(dir);
	return new Promise((resolve, reject) => {					
		fs.readdir(dir, (err, files)=>{
			if(err){
				reject(err);
			}
			else{
				var names = [];
				files.forEach(file => {
					var i = extArray.indexOf(path.extname(file));
					if(i != -1){									
						names.push({name:file, path:dir+file, type:extArray[i]});		
					}
				});	
				logDev(names);	
				resolve(names);
			}
		})
	});
}
