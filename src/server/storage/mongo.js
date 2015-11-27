/*globals requireJS*/
/*jshint node:true, newcap:false*/

/**
 * @module Server:Storage:Mongo
 * @author mmaroti / https://github.com/mmaroti
 * @author pmeijer / https://github.com/pmeijer
 */

'use strict';

var mongodb = require('mongodb'),
    Q = require('q'),

    CONSTANTS = requireJS('common/storage/constants'),
    CANON = requireJS('common/util/canon'),
    REGEXP = requireJS('common/regexp');

function Mongo(mainLogger, gmeConfig) {
    var self = this,
        connectionCnt = 0,
        connectDeferred,
        disconnectDeferred,
        logger = mainLogger.fork('mongo');


    this.client = null;

    /**
     * Provides methods related to a specific project.
     *
     * @param {string} projectId - identifier of the project (ownerId + '.' + projectName).
     * @param {object} collection - Mongo collection connected to database.
     * @constructor
     * @private
     */
    function MongoProject(projectId, collection) {
        this.projectId = projectId;
        this._collection = collection;

        this.closeProject = function (callback) {
            var deferred = Q.defer();
            //TODO: Does this really do something?
            collection = null;
            deferred.resolve();
            return deferred.promise.nodeify(callback);
        };

        this.loadObject = function (hash, callback) {
            var deferred = Q.defer();
            if (typeof hash !== 'string') {
                deferred.reject(new Error('loadObject - given hash is not a string : ' + typeof hash));
            } else if (!REGEXP.HASH.test(hash)) {
                deferred.reject(new Error('loadObject - invalid hash :' + hash));
            } else {
                logger.debug('loadObject ' + hash);
                collection.findOne({_id: hash}, function (err, obj) {
                    if (err) {
                        logger.error(err);
                        deferred.reject(err);
                    } else if (obj) {
                        deferred.resolve(obj);
                    } else {
                        logger.error('object does not exist ' + hash);
                        deferred.reject(new Error('object does not exist ' + hash));
                    }
                });
            }

            return deferred.promise.nodeify(callback);
        };

        this.insertObject = function (object, callback) {
            var deferred = Q.defer(),
                rejected = false;
            if (object === null || typeof object !== 'object') {
                deferred.reject(new Error('object is not an object'));
                rejected = true;
            } else if (typeof object._id !== 'string' || !REGEXP.HASH.test(object._id)) {
                deferred.reject(new Error('object._id is not a valid hash.'));
                rejected = true;
            }
            if (rejected === false) {
                collection.insert(object, function (err) {
                    // manually check duplicate keys
                    if (err && err.code === 11000) {
                        collection.findOne({
                            _id: object._id
                        }, function (err2, data) {
                            var errMsg;
                            if (err2) {
                                deferred.reject(err2);
                            } else {
                                if (CANON.stringify(object) === CANON.stringify(data)) {
                                    logger.info('tried to insert existing hash - the two objects were equal',
                                        object._id);
                                    deferred.resolve();
                                } else {
                                    errMsg = 'tried to insert existing hash - the two objects were NOT equal ';
                                    logger.error(errMsg, {
                                        metadata: {
                                            newObject: CANON.stringify(object),
                                            oldObject: CANON.stringify(data)
                                        }
                                    });
                                    deferred.reject(new Error(errMsg + object._id));
                                }
                            }
                        });
                    } else if (err) {
                        deferred.reject(err);
                    } else {
                        deferred.resolve();
                    }
                });
            }

            return deferred.promise.nodeify(callback);
        };

        this.getBranches = function (callback) {
            var mongoFind = collection.find({
                _id: {
                    $regex: REGEXP.RAW_BRANCH.source
                }
            });

            return Q.ninvoke(mongoFind, 'toArray')
                .then(function (docs) {
                    var branches = {};
                    for (var i = 0; i < docs.length; ++i) {
                        branches[docs[i]._id.slice(1)] = docs[i].hash;
                    }
                    return Q(branches);
                })
                .nodeify(callback);
        };

        this.getBranchHash = function (branch, callback) {
            branch = '*' + branch;

            return Q.ninvoke(collection, 'findOne', {_id: branch})
                .then(function (branchObj) {
                    // FIXME: This behaviour of return empty string rather than an error is the same as before.
                    // FIXME: Consider returning with an error in style with 'Branch does not exist'.
                    return Q((branchObj && branchObj.hash) || '');
                }).nodeify(callback);
        };

        this.setBranchHash = function (branch, oldhash, newhash, callback) {
            var deferred = Q.defer();
            branch = '*' + branch;

            //TODO: Refactor this to a more promise like function (for now keep it close to the original function).
            //TODO: These error messages need to be more to the point.
            if (oldhash === newhash) {
                collection.findOne({
                    _id: branch
                }, function (err, obj) {
                    if (!err && oldhash !== ((obj && obj.hash) || '')) {
                        err = new Error('branch hash mismatch');
                    }
                    if (err) {
                        deferred.reject(err);
                    } else {
                        deferred.resolve();
                    }
                });
            } else if (newhash === '') {
                collection.remove({
                    _id: branch,
                    hash: oldhash
                }, function (err, num) {
                    if (!err && num !== 1) {
                        collection.findOne({_id: branch}, function (err, obj) {
                            if (!err && obj) {
                                err = new Error('branch hash mismatch');
                            }
                            if (err) {
                                deferred.reject(err);
                            } else {
                                deferred.resolve();
                            }
                        });
                    } else if (err) {
                        deferred.reject(err);
                    } else {
                        deferred.resolve();
                    }
                });
            } else if (oldhash === '') {
                collection.insert({
                    _id: branch,
                    hash: newhash
                }, function (err) {
                    if (err) {
                        if (err.code === 11000) { // insertDocument :: caused by :: 11000 E11000 duplicate key error...
                            deferred.reject(new Error('branch hash mismatch'));
                        } else {
                            deferred.reject(err);
                        }
                    } else {
                        deferred.resolve();
                    }
                });
            } else {
                collection.update({
                    _id: branch,
                    hash: oldhash
                }, {
                    $set: {
                        hash: newhash
                    }
                }, function (err, num) {
                    if (!err && num !== 1) {
                        err = new Error('branch hash mismatch');
                    }
                    if (err) {
                        deferred.reject(err);
                    } else {
                        deferred.resolve();
                    }
                });
            }

            return deferred.promise.nodeify(callback);
        };

        this.getCommits = function (before, number, callback) {
            var mongoFind = collection.find({
                type: 'commit',
                time: {
                    $lt: before
                }
            }).limit(number).sort({
                time: -1
            });

            return Q.ninvoke(mongoFind, 'toArray')
                .then(function (docs) {
                    return Q(docs);
                })
                .nodeify(callback);
        };
    }

    function openDatabase(callback) {
        connectionCnt += 1;
        logger.debug('openDatabase, connection counter:', connectionCnt);

        if (connectionCnt === 1) {
            if (self.client === null) {
                logger.debug('Connecting to mongo...');
                connectDeferred = Q.defer();
                // connect to mongo
                mongodb.MongoClient.connect(gmeConfig.mongo.uri, gmeConfig.mongo.options, function (err, db) {
                    if (!err && db) {
                        self.client = db;
                        disconnectDeferred = null;
                        logger.debug('Connected.');
                        connectDeferred.resolve();
                    } else {
                        self.client = null;
                        connectionCnt -= 1;
                        logger.error('Failed to connect.', {metadata: err});
                        connectDeferred.reject(err);
                    }
                });
            } else {
                logger.debug('Count is 1 but mongo is not null');
            }
        } else {
            logger.debug('Reusing mongo connection.');
            // we are already connected
        }

        return connectDeferred.promise.nodeify(callback);
    }

    function closeDatabase(callback) {
        connectionCnt -= 1;
        logger.debug('closeDatabase, connection counter:', connectionCnt);

        if (connectionCnt < 0) {
            logger.error('connection counter became negative, too many closeDatabase. Setting it to 0.', connectionCnt);
            connectionCnt = 0;
        }

        if (!disconnectDeferred) {
            disconnectDeferred = Q.defer();
        }

        if (connectionCnt === 0) {
            if (self.client) {
                logger.debug('Closing connection to mongo...');
                self.client.close(function () {
                    self.client = null;
                    logger.debug('Closed.');
                    disconnectDeferred.resolve();
                });
            } else {
                disconnectDeferred.resolve();
            }
        } else {
            logger.debug('Connections still alive.');
        }

        return disconnectDeferred.promise.nodeify(callback);
    }

    function deleteProject(projectId, callback) {
        var deferred = Q.defer();

        if (self.client) {
            Q.ninvoke(self.client, 'dropCollection', projectId)
                .then(function () {
                    deferred.resolve(true);
                })
                .catch(function (err) {
                    if (err.ok === 0) { // http://docs.mongodb.org/manual/reference/method/db.collection.drop/
                        logger.debug('deleteProject, project does not exist', projectId);
                        deferred.resolve(false);
                    } else {
                        deferred.reject(err);
                    }
                });
        } else {
            deferred.reject(new Error('Database is not open.'));
        }

        return deferred.promise.nodeify(callback);
    }

    function openProject(projectId, callback) {
        var collection,
            deferred = Q.defer();

        logger.debug('openProject', projectId);

        if (self.client) {
            Q.ninvoke(self.client, 'collection', projectId)
                .then(function (result) {
                    collection = result;
                    return Q.ninvoke(result, 'findOne', {}, {_id: 1});
                })
                .then(function (something) {
                    if (!something) {
                        deferred.reject(new Error('Project does not exist ' + projectId));
                    } else {
                        deferred.resolve(new MongoProject(projectId, collection));
                    }
                })
                .catch(deferred.reject);

        } else {
            deferred.reject(new Error('Database is not open.'));
        }

        return deferred.promise.nodeify(callback);
    }

    function createProject(projectId, callback) {
        var collection,
            deferred = Q.defer();

        logger.debug('createProject', projectId);

        if (self.client) {
            Q.ninvoke(self.client, 'collection', projectId)
                .then(function (result) {
                    collection = result;
                    return Q.ninvoke(result, 'findOne', {}, {_id: 1});
                })
                .then(function (something) {
                    if (something) {
                        deferred.reject(new Error('Project already exists ' + projectId));
                    } else {
                        return Q.ninvoke(collection, 'insert', {_id: CONSTANTS.EMPTY_PROJECT_DATA});
                    }
                })
                .then(function () {
                    deferred.resolve(new MongoProject(projectId, collection));
                })
                .catch(deferred.reject);

        } else {
            deferred.reject(new Error('Database is not open.'));
        }

        return deferred.promise.nodeify(callback);
    }

    function renameProject(projectId, newProjectId, callback) {
        var deferred = Q.defer();

        if (self.client) {
            Q.ninvoke(self.client, 'renameCollection', projectId, newProjectId)
                .then(function () {
                    deferred.resolve();
                })
                .catch(function (err) {
                    err = err instanceof Error ? err : new Error(err);
                    if (err.message.indexOf('target namespace exists') > -1) {
                        deferred.reject(new Error('Project already exists ' + newProjectId));
                    } else if (err.message.indexOf('source namespace does not exist') > -1) {
                        deferred.reject(new Error('Project does not exist ' + projectId));
                    } else {
                        deferred.reject(err);
                    }
                });
        } else {
            deferred.reject(new Error('Database is not open.'));
        }

        return deferred.promise.nodeify(callback);
    }

    function duplicateProject(projectId, newProjectId, callback) {
        var project,
            newProject;

        logger.debug('duplicateProject', projectId);

        return self.openProject(projectId)
            .then(function (project_) {
                project = project_;
                return self.createProject(newProjectId);
            })
            .then(function (newProject_) {
                newProject = newProject_;
                return Q.ninvoke(project._collection, 'aggregate', [{ $out: newProjectId }]);
            })
            .then(function () {
                return newProject;
            });
    }

    this.openDatabase = openDatabase;
    this.closeDatabase = closeDatabase;

    this.openProject = openProject;
    this.deleteProject = deleteProject;
    this.createProject = createProject;
    this.renameProject = renameProject;
    this.duplicateProject = duplicateProject;
}

module.exports = Mongo;
