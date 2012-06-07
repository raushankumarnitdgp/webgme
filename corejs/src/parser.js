/*
 * Copyright (C) 2012 Vanderbilt University, All rights reserved.
 * 
 * Author: Miklos Maroti
 */

var requirejs = require("requirejs");

requirejs.config({
	nodeRequire: require
});

requirejs(
[ "assert", "lib/sax", "fs", "mongo", "branch", "config", "util" ],
function (ASSERT, SAX, FS, Mongo, Branch, CONFIG, UTIL) {
	"use strict";

	// ------- parser -------

	var parse = function (storage, filename, callback) {
		ASSERT(storage && filename && callback);

		var ids = {};
		var idCount = 0;

		var timerhandle = setInterval(function () {
			console.log("  at line " + parser._parser.line + " (" + total + " objects, " + idCount
			+ " ids)");
		}, CONFIG.parser.reportingTime);

		var branch = new Branch(storage);

		var exit = function (err, result) {
			if( timerhandle ) {
				clearInterval(timerhandle);
				timerhandle = undefined;
			}

			if( callback ) {
				callback(err, result);
				callback = undefined;
			}
		};

		var tags = [];

		var persisting = 1;
		var persist = function () {
			ASSERT(tags.length !== 0);
			ASSERT(persisting >= 1);

			branch.persist(tags[0].node, function (err) {
				if( err ) {
					exit(err);
				}
				else if( --persisting === 0 ) {
					var key = branch.getKey(tags[0].node);

					console.log("Parsing done (" + total + " objects, " + idCount + " ids)");
					console.log("Root key = " + key);

					tags = null;
					branch = null;

					exit(null, key);
				}
			});
		};

		var total = 0;
		var counter = 0;

		var addTag = function (tag) {
			var node = branch.createNode();

			if( tags.length !== 0 ) {
				branch.attach(node, tags[tags.length - 1].node);
			}

			for( var key in tag.attributes ) {
				branch.setAttribute(node, key, tag.attributes[key]);
			}

			branch.setAttribute(node, "#tag", tag.name);

			if( tag.attributes.id ) {
				ASSERT(ids[tag.attributes.id] === undefined);

				ids[tag.attributes.id] = branch.getStringPath(node);
				++idCount;
			}

			tag.text = "";
			tag.node = node;

			++total;
			if( ++counter >= CONFIG.parser.persistingLimit ) {
				++persisting;
				persist();
				counter = 0;
			}

			tags.push(tag);
		};

		addTag({
			name: "Root",
			attributes: {
				created: (new Date()).toString()
			}
		});

		var parser = SAX.createStream(true, {
			trim: true
		});

		parser.on("opentag", addTag);

		parser.on("closetag", function (name) {
			ASSERT(tags.length >= 2);

			var tag = tags.pop();
			ASSERT(tag.name === name);

			if( tag.text !== "" ) {
				branch.setAttribute(tag.node, "text", tag.text);
			}
		});

		parser.on("text", function (text) {
			if( tags.length !== 0 ) {
				var tag = tags[tags.length - 1];
				tag.text += text;
			}
		});

		parser.on("error", function (err) {
			exit("Unknown parser error: " + JSON.stringify(err));
		});

		parser.on("end", function () {
			ASSERT(tags.length === 1);
			branch.setAttribute(tags[0].node, "#ids", ids);
			persist();
		});

		var stream = FS.createReadStream(filename);

		stream.on("error", function (err) {
			exit(err.code === "ENOENT" ? "File not found: " + filename : "Unknown file error: "
			+ JSON.stringify(err));
		});

		stream.on("open", function () {
			console.log("Parsing xml file ...");
			stream.pipe(parser);
		});
	};

	// ------- reader -------

	var comparePaths = function (a, b) {
		ASSERT(a.constructor === Array);
		ASSERT(b.constructor === Array);

		var c = a.length;
		var d = b.length;

		while( --c >= 0 && --d >= 0 ) {
			var t = a[c] - b[d];
			if( t !== 0 ) {
				return t;
			}
		}

		return a.length - b.length;
	};

	var reader = function (storage, key, callback) {
		var branch = new Branch(storage);
		var count = 0;

		var timerhandle;

		var enqueue = UTIL.priorityQueue(CONFIG.reader.concurrentReads, comparePaths,
		function (err) {
			clearInterval(timerhandle);
			console.log("Reading done (" + count + " objects)");
			callback(err);
		});

		var process = function (path, done, node) {
			++count;
			branch.loadChildren(node, function (err, children) {
				if( !err ) {
					for( var i = 0; i < children.length; ++i ) {
						var child = children[i];
						enqueue(branch.getPath(child), process, child);
					}
				}
				done(err);
			});
		};

		branch.loadRoot(key, function (err, node) {
			if( err ) {
				callback(err);
			}
			else {
				console.log("Reading tree ...");
				timerhandle = setInterval(function () {
					console.log("  reading " + count + " objects");
				}, CONFIG.reader.reportingTime);

				enqueue(branch.getPath(node), process, node);
			}
		});
	};

	// ------- metabuilder -------

	var metabuilder = function (storage, key, callback) {
		var branch = new Branch(storage);

		var metaroot = branch.createNode();
		var paradigm = branch.createNode();
		branch.attach(paradigm, metaroot);

		var enqueue = UTIL.priorityEnqueue(CONFIG.reader.concurrentReads, comparePaths, function (
		err) {
			if( err ) {
				console.log("Building error: " + JSON.stringify(err));
				callback(err);
			}
			else {
				console.log("Building done");
				branch.persist(metaroot, function (err2) {
					console.log("Saving meta " + (err2 ? " error:" + err2 : "done"));
					branch.dumpTree(branch.getKey(metaroot), function (err3) {
						callback(err2);
					});
				});
			}
		});

		var getChildByTag = function (node, name, callback2) {
			branch.loadChildren(node, function (err, children) {
				if( err ) {
					callback2(err);
				}
				else {
					for( var i = 0; i < children.length; ++i ) {
						if( branch.getAttribute(children[i], "#tag") === name ) {
							callback2(null, children[i]);
							return;
						}
					}
					callback2(null, null);
				}
			});
		};

		var copyAttributes = function (xmlNode, metaNode, attrs) {
			if( !attrs ) {
				attrs = Object.keys(branch.getAttributes(xmlNode));
			}

			for( var i = 0; i < attrs.length; ++i ) {
				var attr = attrs[i];
				ASSERT(typeof attr === "string");
				var value = branch.getAttribute(xmlNode, attr);
				if( value ) {
					branch.setAttribute(metaNode, attr, value);
				}
			}
		};

		var attributes = {};
		var parseAttribute = function(xmlnode) {
			ASSERT(xmlnode && callback);
			
			var path = branch.getStringPath(xmlnode);
			var meta = attributes[path];
			if(meta) {
				return meta;
			}
			else {
				meta = branch.createNode();
				branch.attach(meta, paradigm);
				
				copyAttributes(xmlnode, meta);
			}
		};
		
		var process = function (path, done, node) {
			var errorHandler = UTIL.errorHandler(done);

			var tag = branch.getAttribute(node, "#tag");

			if( branch.getLevel(node) === 1 && tag !== "paradigm" ) {
				errorHandler("Not a meta paradigm");
				return;
			}

			if( tag === "attrdef" ) {
				var metaobj = branch.createNode();
				branch.attach(metaobj, paradigm);

				copyAttributes(node, metaobj);
			}

			if( tag === "paradigm" ) {

				copyAttributes(node, paradigm);

				getChildByTag(node, "comment", errorHandler(function (node2) {
					if( node2 ) {
						branch
						.setAttribute(paradigm, "comment", branch.getAttribute(node2, "text"));
					}
				}));

				getChildByTag(
				node,
				"author",
				errorHandler(function (node2) {
					if( node2 ) {
						branch.setAttribute(paradigm, "author", branch.getAttribute(node2, "text"));
					}
				}));

				getChildByTag(node, "dispname", errorHandler(function (node2) {
					if( node2 ) {
						branch.setAttribute(paradigm, "dispname", branch
						.getAttribute(node2, "text"));
					}
				}));
			}

			branch.loadChildren(node, errorHandler(function (children) {
				for( var i = 0; i < children.length; ++i ) {
					var child = children[i];
					enqueue(branch.getPath(child), process, child);
				}
			}));

			errorHandler(null);
		};

		branch.loadRoot(key, function (err, node) {
			if( err ) {
				callback(err);
			}
			else {
				console.log("Building meta objects ...");
				enqueue(branch.getPath(node), process, node);
			}
		});
	};

	// ------- database -------

	var mongo = new Mongo();

	var closeDatabase = function () {
		if( mongo.opened() ) {
			mongo.close();
		}
	};

	var openDatabase = function (callback) {
		ASSERT(callback);

		console.log("Opening database");
		mongo.open(function (err1) {
			if( err1 ) {
				closeDatabase();
				callback("Could not connect to database: " + JSON.stringify(err1));
			}
			else {
				console.log("Clearing database");
				mongo.removeAll(function (err2) {
					if( err2 ) {
						closeDatabase();
						callback("Could not remove previous objects: " + JSON.stringify(err2));
					}
					else {
						callback();
					}
				});
			}
		});
	};

	// ------- main -------

	var filename = process.argv[2];
	if( !filename ) {
		console.log("Usage: node parser.js <file.xml>");
	}
	else {
		openDatabase(function (err1) {
			if( err1 ) {
				console.log(err1);
			}
			else {
				parse(mongo, filename, function (err2, key) {
					if( err2 ) {
						console.log(err2);
					}

					metabuilder(mongo, key, function (err3) {
						console.log("Closing database");
						closeDatabase();
					});
				});
			}
		});
	}
});
