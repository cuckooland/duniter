"use strict";
var Q       = require('q');
var _       = require('underscore');
var sha1    = require('sha1');
var async   = require('async');
var moment = require('moment');
var util = require('util');
var Identity = require('../entity/identity');
var Membership = require('../entity/membership');
var Merkle = require('../entity/merkle');
var Transaction = require('../entity/transaction');
var Source = require('../entity/source');
var constants = require('../constants');
var fsMock = require('q-io/fs-mock')({});
var GlobalDAL = require('./fileDALs/GlobalDAL');
var ConfDAL = require('./fileDALs/confDAL');
var StatDAL = require('./fileDALs/statDAL');
var CertDAL = require('./fileDALs/CertDAL');
var MerkleDAL = require('./fileDALs/MerkleDAL');
var TxsDAL = require('./fileDALs/TxsDAL');
var CoresDAL = require('./fileDALs/CoresDAL');
var IndicatorsDAL = require('./fileDALs/IndicatorsDAL');

var BLOCK_FILE_PREFIX = "0000000000";
var BLOCK_FOLDER_SIZE = 500;

var writeFileFifo = async.queue(function (task, callback) {
  task(callback);
}, 1);

module.exports = {
  memory: function(profile, subPath) {
    return getHomeFS(profile, subPath, true)
      .then(function(params) {
        return Q(new FileDAL(profile, subPath, params.fs));
      });
  },
  file: function(profile, subPath) {
    return getHomeFS(profile, subPath, false)
      .then(function(params) {
        return new FileDAL(profile, subPath, params.fs);
      });
  },
  FileDAL: FileDAL
};

function someDelayFix() {
  return Q.Promise(function(resolve){
    setTimeout(resolve, 100);
  });
}

function getHomeFS(profile, subpath, isMemory) {
  var home = getUCoinHomePath(profile, subpath);
  var fs;
  return someDelayFix()
    .then(function() {
      fs = (isMemory ? fsMock : require('q-io/fs'));
      return fs.makeTree(home);
    })
    .then(function(){
      return { fs: fs, home: home };
    });
}

function getUCoinHomePath(profile) {
  var userHome = process.env.HOME || process.env.HOMEPATH || process.env.USERPROFILE;
  return userHome + '/.config/ucoin/' + profile;
}

function FileDAL(profile, subPath, myFS, rootDAL) {

  var that = this;

  this.name = 'fileDal';
  this.profile = profile;
  this.readFunctions = [];
  this.writeFunctions = [];
  this.existsFunc = existsFunc;

  var rootPath = getUCoinHomePath(profile) + (subPath ? '/' + subPath : '');
  var logger = require('../../lib/logger')(profile);

  // DALs
  var globalDAL = new GlobalDAL(that);
  var confDAL = new ConfDAL(that);
  var statDAL = new StatDAL(that);
  var certDAL = new CertDAL(that);
  var merkleDAL = new MerkleDAL(that);
  var indicatorsDAL = new IndicatorsDAL(that);
  var txsDAL = new TxsDAL(that);
  var coresDAL = new CoresDAL(that);
  var dals = [confDAL, statDAL, globalDAL, certDAL, indicatorsDAL, merkleDAL, txsDAL, coresDAL];

  var links = [];
  var sources = [];
  var memberships = [];
  var identities = [];
  var peers = [];
  var currency = '';

  var lastBlockFileNumber = -1;

  var dalLoaded;
  function onceLoadedDAL() {
    return dalLoaded || (dalLoaded = myFS.makeTree(rootPath)
      .then(function(){
        return (rootDAL ? rootDAL.copyFiles.now(rootPath) : Q.resolve());
      })
      .then(function(){
        return Q.all([
          loadIntoArray(links, 'links.json'),
          loadIntoArray(sources, 'sources.json'),
          loadIntoArray(memberships, 'memberships.json'),
          loadIntoArray(identities, 'identities.json'),
          loadIntoArray(peers, 'peers.json'),
          getCurrentMaxNumberInBlockFiles()
            .then(function(max){
              lastBlockFileNumber = max;
            })
        ]);
      }));
  }

  this.copyFiles = function(newRoot) {
    return [
      'links.json',
      'sources.json',
      'memberships.json',
      'identities.json',
      'peers.json',
    ].reduce(function(p, fileName) {
      var source = rootPath + '/' + fileName;
      var dest = newRoot + '/' + fileName;
      return p
        .then(function(){
          return myFS.exists(source);
        })
        .then(function(exists){
          if (exists) {
            //console.log('Copy from %s to %s', rootPath + '/' + fileName, newRoot + '/' + fileName);
            return myFS.read(source)
              .then(function(content){
                return myFS.write(dest, content);
              })
              .then(function(){
                return myFS.read(dest);
              });
          }
          else {
            //console.log('Create empty array file %s', newRoot + '/' + fileName);
            return writeJSONToPath([], newRoot + '/' + fileName);
          }
        });
    }, Q());
  };

  function folderOfBlock(blockNumber) {
    return (Math.floor(blockNumber / BLOCK_FOLDER_SIZE) + 1) * BLOCK_FOLDER_SIZE;
  }

  function pathOfBlock(blockNumber) {
    return rootPath + '/blocks/' + folderOfBlock(blockNumber) + '/' + blockFileName(blockNumber) + '.json';
  }

  this.removeHome = function() {
    return myFS.removeTree(rootPath);
  };

  this.hasFileOfBlock = function(blockNumber) {
    if(blockNumber > lastBlockFileNumber) {
      // Update the current last number
      return that.getCurrentMaxNumberInBlockFilesMember()
        .then(function(maxNumber){
          lastBlockFileNumber = maxNumber;
          return blockNumber <= lastBlockFileNumber;
        });
    } else {
      return true;
    }
  };

  this.getCurrentMaxNumberInBlockFilesMember = getCurrentMaxNumberInBlockFiles;

  function getCurrentMaxNumberInBlockFiles() {
    // Look in local files
    return myFS.makeTree(rootPath + '/blocks/')
      .then(function(){
        return myFS.list(rootPath + '/blocks/');
      })
      .then(function(files){
        if(files.length == 0){
          return -1;
        } else {
          var maxDir = _.max(files, function(dir){ return parseInt(dir); });
          return myFS.list(rootPath + '/blocks/' + maxDir + '/')
            .then(function(files){
              if(files.length > 0) {
                return parseInt(_.max(files, function (f) {
                  return parseInt(f);
                }).replace(/\.json/, ''));
              }
              else{
                // Last number is the one of the directory, minus the chunk of director, minus 1
                return maxDir - BLOCK_FOLDER_SIZE - 1;
              }
            });
        }
      });
  }

  this.readFileOfBlock = function(blockNumber) {
    return myFS.read(pathOfBlock(blockNumber));
  };

  that.writeFileOfBlock = function(block) {
    return myFS.write(pathOfBlock(block.number), JSON.stringify(block, null, ' '))
      .then(function(){
        return globalDAL.setLastSavedBlockFile(block.number);
      });
  };

  var blocksTreeLoaded = {};
  this.onceMadeTree = function(blockNumber) {
    var folder = folderOfBlock(blockNumber);
    if (!blocksTreeLoaded[folder]) {
      blocksTreeLoaded[folder] = ((function () {
        return myFS.makeTree(rootPath + '/blocks/' + folderOfBlock(blockNumber));
      })());
    }
    return blocksTreeLoaded[folder];
  };

  function loadIntoArray(theArray, fileName) {
    return myFS.exists(rootPath + '/' + fileName)
      .then(function(exists){
        if (exists) {
          return myFS.read(rootPath + '/' + fileName)
            .then(function (data) {
              JSON.parse(data).forEach(function(item){
                theArray.push(item);
              });
            });
        }
      });
  }

  this.getCores = function() {
    return coresDAL.getCores();
  };

  this.loadCore = function(core) {
    return require('./coreDAL')(profile, core.forkPointNumber, core.forkPointHash, myFS, that);
  };

  this.addCore = function(core) {
    return coresDAL.addCore(core);
  };

  this.fork = function(newBlock) {
    var core = {
      forkPointNumber: parseInt(newBlock.number),
      forkPointHash: newBlock.hash,
      forkPointPreviousHash: newBlock.previousHash
    };
    return coresDAL.getCore(core)
      .fail(function(){
        return null;
      })
      .then(function(existing){
        if (existing) {
          throw 'Fork ' + [core.forkPointNumber, core.forkPointHash].join('-') + ' already exists';
        }
        return that.addCore(core)
          .then(function(){
            return that.loadCore(core);
          });
      });
  };

  this.unfork = function(loadedCore) {
    return loadedCore.current()
      .then(function(current){
        var core = {
          forkPointNumber: current.number,
          forkPointHash: current.hash
        };
        return coresDAL.removeCore(core)
          .then(function(){
            return loadedCore.dal.removeHome();
          });
      });
  };

  this.listAllPeers = function(done) {
    done && done(null, peers);
    return Q(peers);
  };

  function nullIfError(promise, done) {
    return promise
      .then(function(p){
        done && done(null, p);
        return p;
      })
      .fail(function(){
        done && done(null, null);
        return null;
      });
  }

  function nullIfErrorIs(promise, expectedError, done) {
    return promise
      .then(function(p){
        done && done(null, p);
        return p;
      })
      .fail(function(err){
        if (err == expectedError) {
          done && done(null, null);
          return null;
        }
        if (done) {
          done(err);
          return null;
        }
        throw err;
      });
  }

  this.getPeer = function(pubkey, done) {
    var matching = _.chain(peers).
      where({ pubkey: pubkey }).
      value();
    done && done(!matching[0] && 'Unknown peer ' + pubkey, matching[0] || null);
    return Q(matching[0] || null);
  };

  this.getBlock = function(number, done) {
    return that.readFileOfBlock(number)
      .then(function(data) {
        return JSON.parse(data);
      })
      .fail(function(){
        throw 'Block ' + number + ' not found on DAL ' + that.name;
      })
      .then(function(block){
        done && done(null, block);
        return block;
      })
      .fail(function(err){
        done && done(err);
        throw err;
      });
  };

  this.getBlockByNumberAndHash = function(number, hash, done) {
    return that.readFileOfBlock(number)
      .then(function(data) {
        return JSON.parse(data);
      })
      .then(function(block){
        if (block.hash != hash) throw "Not found";
        else return block;
      })
      .fail(function(){
        throw 'Block ' + [number, hash].join('-') + ' not found';
      })
      .then(function(block){
        done && done(null, block);
        return block;
      })
      .fail(function(err){
        done && done(err);
        throw err;
      });
  };

  this.getCurrent = function(done) {
    return that.getBlockCurrent(done);
  };

  this.getCurrentBlockOrNull = function(done) {
    return nullIfErrorIs(that.getBlockCurrent(), constants.ERROR.BLOCK.NO_CURRENT_BLOCK, done);
  };

  this.getPromoted = function(number, done) {
    return that.getBlock(number, done);
  };

  // Block
  this.lastUDBlock = function() {
    return indicatorsDAL.getLastUDBlock();
  };

  this.getRootBlock = function(done) {
    return that.getBlock(0, done);
  };

  this.lastBlockOfIssuer = function(issuer) {
    return indicatorsDAL.getLastBlockOfIssuer(issuer);
  };

  this.getBlocksBetween = function(start, end) {
    var s = Math.max(0, start);
    return Q.all(_.range(s, end + 1).map(function(number) {
      return that.getBlock(number);
    }))
      .then(function(results){
        return results.reduce(function(blocks, block) {
          if (block) {
            return blocks.concat(block);
          }
          return blocks;
        }, [])
      });
  };

  this.getCurrentNumber = function() {
    return globalDAL.getGlobal().get('currentNumber');
  };

  this.getLastSavedBlockFileNumber = function() {
    return globalDAL.getGlobal()
      .then(function(global){
        return global.lastSavedBlockFile || -1;
      });
  };

  this.getBlockCurrent = function(done) {
    return that.getCurrentNumber()
      .then(function(number) {
        if (number != -1)
          return that.getBlock(number);
        else
          throw 'No current block';
      })
      .then(function(block){
        done && done(null, block);
        return block;
      });
  };

  this.getBlockFrom = function(number) {
    return that.getCurrent()
      .then(function(current){
        return that.getBlocksBetween(number, current.number);
      });
  };

  this.getBlocksUntil = function(number) {
    return that.getBlocksBetween(0, number);
  };

  this.getValidLinksFrom = function(from, done) {
    var matching =_.chain(links).
      where({ source: from, obsolete: false }).
      value();
    done && done(null, matching);
    return matching;
  };

  this.getValidLinksTo = function(to, done) {
    var matching =_.chain(links).
      where({ target: to, obsolete: false }).
      value();
    done && done(null, matching);
    return matching;
  };

  this.currentValidLinks = function(fpr, done) {
    var matching = _.chain(links).
      where({ target: fpr, obsolete: false }).
      value();
    done && done(null, matching);
    return matching;
  };

  this.getObsoletesFromTo = function(from, to, done) {
    var matching =_.chain(links).
      where({ source: from, target: to, obsolete: true }).
      sortBy(function(lnk){ return -lnk.timestamp; }).
      first(1).
      value();
    done && done(null, matching);
    return matching;
  };

  this.getValidFromTo = function(from, to, done) {
    var matching =_.chain(links).
      where({ source: from, target: to, obsolete: false }).
      value();
    done && done(null, matching);
    return matching;
  };

  this.getAvailableSourcesByPubkey = function(pubkey, done) {
    var matching =_.chain(sources).
      where({ pubkey: pubkey, consumed: false }).
      value();
    done && done(null, matching);
    return matching;
  };

  this.getIdentityByPubkeyAndHashOrNull = function(pubkey, hash, done) {
    var matching = _.chain(identities).
      where({ pubkey: pubkey, hash: hash }).
      value();
    done && done(null, matching[0] || null);
    return matching[0] || null;
  };

  this.getIdentityByHashOrNull = function(hash, done) {
    var matching = _.chain(identities).
      where({ hash: hash }).
      value();
    done && done(null, matching[0] || null);
    return matching[0] || null;
  };

  this.getIdentityByHashWithCertsOrNull = function(hash, done) {
    return that.fillIdentityWithCerts(Q(that.getIdentityByHashOrNull(hash)), done);
  };

  this.fillIdentityWithCerts = function(idtyPromise, done) {
    return idtyPromise
      .then(function(idty){
        if (idty && !idty.length) {
          return certDAL.getToTarget(idty.hash)
            .then(function(certs){
              idty.certs = certs;
              return idty;
            });
        }
        return idty;
      })
      .then(function(idty){
        done && done(null, idty);
        return idty;
      })
      .fail(function(){
        done && done(null, null);
        return null;
      });
  };

  this.getMembers = function(done) {
    var matching = _.chain(identities).
      where({ member: true }).
      value();
    done && done(null, matching);
    return matching;
  };

  this.getWritten = function(pubkey, done) {
    return that.fillInMembershipsOfIdentity(
      Q(_.chain(identities).
        where({ pubkey: pubkey, wasMember: true }).
        value()[0] || null), done);
  };

  this.fillInMembershipsOfIdentity = function(queryPromise, done) {
    return Q(queryPromise)
      .tap(function(row){
        if (row) {
          row.memberships = [].concat(
            _.where(memberships, { type: 'join', issuer: row.pubkey })
          ).concat(
            _.where(memberships, { type: 'active', issuer: row.pubkey })
          ).concat(
            _.where(memberships, { type: 'leave', issuer: row.pubkey })
          );
        }
      })
      .then(function(rows){
        done && done(null, rows);
        return rows;
      })
      .fail(function(err){
        done && done(null, null);
      });
  };

  this.findPeersWhoseHashIsIn = function(hashes, done) {
    var matching = _.chain(peers).
      filter(function(p){ return hashes.indexOf(p.hash) !== -1; }).
      value();
    done && done(null, matching);
    return matching;
  };

  this.getTxByHash = function(hash) {
    return txsDAL.getTX(hash);
  };

  this.removeTxByHash = function(hash) {
    return txsDAL.removeTX(hash);
  };

  this.getTransactionsPending = function() {
    return txsDAL.getAllPending();
  };

  this.getNonWritten = function(pubkey, done) {
    var matching = _.chain(identities).
      where({ pubkey: pubkey, wasMember: false }).
      value();
    done && done(null, matching);
    return matching;
  };

  this.getToBeKicked = function(done) {
    var matching =_.chain(identities).
      where({ kick: true }).
      value();
    done && done(null, matching);
    return matching;
  };

  this.getWrittenByUID = function(uid, done) {
    return that.fillIdentityWithCerts(
      Q(_.chain(identities).
      where({ wasMember: true, uid: uid }).
      value()[0] || null), done);
  };

  this.searchIdentity = function(search, done) {
    var idties = _.chain(identities).
      where({ revoked: false }).
      filter(function(idty){ return idty.pubkey.match(new RegExp(search, 'i')) || idty.uid.match(new RegExp(search, 'i')); }).
      value();
    return that.fillIdentityWithCerts(Q(idties), done);
  };

  this.certsToTarget = function(hash) {
    return certDAL.getToTarget(hash)
      .then(function(certs){
        var matching = _.chain(certs).
          sortBy(function(c){ return -c.block; }).
          value();
        matching.reverse();
        return matching;
      })
      .fail(function(err){
        throw err;
      });
  };

  this.certsFrom = function(pubkey) {
    return certDAL.getFromPubkey(pubkey)
      .then(function(certs){
        return _.chain(certs).
          where({ from: pubkey }).
          sortBy(function(c){ return c.block; }).
          value();
      });
  };

  this.certsFindNew = function() {
    return certDAL.getNotLinked()
      .then(function(certs){
        return _.chain(certs).
          where({ linked: false }).
          sortBy(function(c){ return -c.block; }).
          value();
      });
  };

  this.certsNotLinkedToTarget = function(hash) {
    return certDAL.getNotLinkedToTarget(hash)
      .then(function(certs){
        return _.chain(certs).
          sortBy(function(c){ return -c.block; }).
          value();
      });
  };

  this.getMembershipsForHashAndIssuer = function(hash, issuer, done) {
    var matching =_.chain(memberships).
      where({ issuer: issuer, fpr: hash }).
      sortBy(function(c){ return -c.sigDate; }).
      value();
    done && done(null, matching);
    return matching;
  };

  this.findNewcomers = function(done) {
    var matching =_.chain(memberships).
      where({ membership: 'IN' }).
      sortBy(function(c){ return -c.sigDate; }).
      value();
    done && done(null, matching);
    return matching;
  };

  this.findLeavers = function(done) {
    var matching =_.chain(memberships).
      where({ membership: 'OUT' }).
      sortBy(function(c){ return -c.sigDate; }).
      value();
    done && done(null, matching);
    return matching;
  };

  this.existsLinkFromOrAfterDate = function(from, to, maxDate) {
    var matching =_.chain(links).
      where({ source: from, target: to}).
      filter(function(lnk){ return lnk.timestamp >= maxDate; }).
      value();
    return matching.length ? true : false;
  };

  this.existsNotConsumed = function(type, pubkey, number, fingerprint, amount, done) {
    var matching =_.chain(sources).
      where({ type: type, pubkey: pubkey, number: number, fingerprint: fingerprint, amount: amount, consumed: false }).
      sortBy(function(src){ return -src.number; }).
      value();
    done && done(null, matching.length > 0);
    return matching.length > 0;
  };

  this.isMember = function(pubkey, done) {
    var matching = _.chain(identities).
      where({ pubkey: pubkey, member: true }).
      value();
    done && done(null, matching.length > 0);
    return matching.length > 0;
  };

  this.isMemberOrError = function(pubkey, done) {
    var matching = _.chain(identities).
      where({ pubkey: pubkey, member: true }).
      value();
    done && done((!matching.length && 'Is not a member') || null);
    return matching.length > 0;
  };

  this.isLeaving = function(pubkey, done) {
    var matching = _.chain(identities).
      where({ pubkey: pubkey, member: true, leaving: true }).
      value();
    done && done(null, matching.length > 0);
    return matching.length > 0;
  };

  this.isMembeAndNonLeaverOrError = function(pubkey, done) {
    var matching = _.chain(identities).
      where({ pubkey: pubkey, member: true, leaving: false }).
      value();
    done && done((!matching.length && 'Not a non-leaving member') || null);
    return matching.length > 0;
  };

  this.existsCert = function(cert) {
    return certDAL.existsGivenCert(cert);
  };

  this.obsoletesLinks = function(minTimestamp, done) {
    var matching = _.chain(links).
      filter(function(link){ return link.timestamp <= minTimestamp; }).
      value();
    matching.forEach(function(i){
        i.obsolete = true;
      });
    return matching.length ? that.writeJSON(links, 'links.json', done) : that.donable(Q(), done);
  };

  this.setConsumedSource = function(type, pubkey, number, fingerprint, amount, done) {
    var matching =_.chain(sources).
      where({ type: type, pubkey: pubkey, number: number, fingerprint: fingerprint, amount: amount }).
      sortBy(function(src){ return -src.number; }).
      value();
    matching[0].consumed = true;
    return that.writeJSON(sources, 'sources.json', done);
  };

  this.setKicked = function(pubkey, hash, notEnoughLinks, done) {
    var kicked = notEnoughLinks ? true : false;
    var matching =_.chain(identities).
      where({ pubkey: pubkey, hash: hash }).
      value();
    var oneChanged = false;
    matching.forEach(function(i){
      oneChanged = oneChanged || (!i.kick && kicked);
      i.kick = i.kick || kicked;
    });
    return oneChanged ? saveIdentitiesInFile(identities, function(err) {
      done && done(err);
    }) : that.donable(Q(), done);
  };

  this.deleteIfExists = function(ms, done) {
    var prevCount = memberships.length;
    memberships = _.reject(memberships, function(aMS) {
      return aMS.membership == ms.membership
        && aMS.issuer == ms.issuer
        && aMS.userid == ms.userid
        && aMS.certts == ms.certts
        && aMS.number == ms.number
        && aMS.fpr == ms.fpr;
    });
    return memberships.length != prevCount ? that.writeJSON(memberships, 'memberships.json', done) : that.donable(Q(), done);
  };

  this.getMembershipExcludingBlock = function(current, msValidtyTime) {
    var currentExcluding = current.number == 0 ?
      Q(null) :
      indicatorsDAL.getCurrentMembershipExcludingBlock()
        .fail(function() { return null; });
    return currentExcluding
      .then(function(excluding){
        var reachedMax = false;
        return _.range((excluding && excluding.number) || 0, current.number + 1).reduce(function(p, number) {
          return p.then(function(previous){
            if (reachedMax) return Q(previous);
            return that.getBlock(number)
              .then(function(block){
                if (block.medianTime <= current.medianTime - msValidtyTime) {
                  return block;
                }
                reachedMax = true;
                return previous;
              });
          });
        }, Q(excluding));
      })
      .then(function(newExcluding){
        return indicatorsDAL.writeCurrentExcluding(newExcluding).thenResolve(newExcluding);
      });
  };

  this.kickWithOutdatedMemberships = function(maxNumber) {
    var matching =_.chain(identities).
      where({ member: true }).
      filter(function(i){ return i.currentMSN <= maxNumber; }).
      value();
    matching.forEach(function(i){
      i.kick = true;
    });
    return matching.length ? saveIdentitiesInFile(identities, function(err) {
    }) : Q();
  };

  this.getPeerOrNull = function(pubkey, done) {
    return nullIfError(that.getPeer(pubkey), done);
  };

  this.getBlockOrNull = function(number, done) {
    return nullIfError(that.getBlock(number), done);
  };

  this.getAllPeers = function(done) {
    done && done(null, peers);
    return peers;
  };

  this.findAllPeersNEWUPBut = function(pubkeys, done) {
    return that.listAllPeers()
      .then(function(peers){
        return peers.filter(function(peer) {
          return pubkeys.indexOf(peer.pubkey) == -1 && ['UP'].indexOf(peer.status) !== -1;
        });
      })
      .then(function(matchingPeers){
        done && done(null, matchingPeers);
        return matchingPeers;
      })
      .fail(done);
  };

  this.listAllPeersWithStatusNewUP = function(done) {
    var matching = _.chain(peers).
      filter(function(p){ return ['UP'].indexOf(p.status) !== -1; }).
      value();
    done && done(null, matching);
    return Q(matching);
  };

  this.findPeers = function(pubkey, done) {
    var matching = _.chain(peers).
      where({ pubkey: pubkey }).
      value();
    done && done(null, matching);
    return matching;
  };

  this.getRandomlyUPsWithout = function(pubkeys, done) {
    return that.listAllPeersWithStatusNewUP()
      .then(function(peers){
        return peers.filter(function(peer) {
          return pubkeys.indexOf(peer.pubkey) == -1;
        });
      })
      .then(function(matchingPeers){
        done && done(null, matchingPeers);
        return matchingPeers;
      })
      .fail(done);
  };

  this.setDownWithStatusOlderThan = function(minSigTimestamp, done) {
    var matching = _.chain(peers).
      filter(function(p){ return !p.statusTS || p.statusTS < minSigTimestamp; }).
      value();
    matching.forEach(function(p){
      p.status = 'DOWN';
    });
    return that.writeJSON(peers, 'peers.json', done);
  };

  this.setPeerDown = function(pubkey, done) {
    var matching = _.chain(peers).
      where({ pubkey: pubkey }).
      value();
    matching.forEach(function(p){
      p.status = 'DOWN';
    });
    return that.writeJSON(peers, 'peers.json', done);
  };

  this.saveBlock = function(block, done) {
    return Q()
      .then(function() {
        return Q.all([
          that.saveBlockInFile(block, true),
          that.saveTxsInFiles(block.transactions, { block_number: block.number, time: block.medianTime }),
          that.saveMemberships('join', block.joiners),
          that.saveMemberships('active', block.actives),
          that.saveMemberships('leave', block.leavers)
        ]);
      })
      .then(function(){
        return globalDAL.setCurrentNumber(block.number);
      })
      .then(function(){
        if (block.dividend) {
          return indicatorsDAL.setLastUDBlock(block);
        }
      })
      .then(function(){
        return indicatorsDAL.setLastBlockForIssuer(block);
      })
      .then(function(){
        lastBlockFileNumber = Math.max(lastBlockFileNumber, block.number);
        done && done();
      })
      .fail(function(err){
        done && done(err);
        throw err;
      });
  };

  this.saveMemberships = function (type, mss) {
    return Q.all(mss.map(function(msRaw) {
      var ms = Membership.statics.fromInline(msRaw, type == 'leave' ? 'OUT' : 'IN', currency);
      ms.type = type;
      ms.hash = sha1(ms.getRawSigned()).toUpperCase();
      return that.saveMembership(ms);
    }));
  };

  this.saveMembership = function(ms, done) {
    var existing = _.where(memberships, { hash: ms.hash })[0];
    if (!existing) {
      memberships.push(ms);
    } else {
      _.extend(existing, ms);
    }
    return that.writeJSON(memberships, 'memberships.json', done);
  };

  that.saveBlockInFile = function(block, check, done) {
    return that.onceMadeTree(block.number)
      .then(function(){
        return check ? that.hasFileOfBlock(block.number) : false;
      })
      .then(function(exists){
        return exists ? Q() : that.writeFileOfBlock(block);
      })
      .then(function(){
        done && done();
      })
      .fail(function(err){
        done && done(err);
        throw err;
      });
  };

  this.saveTxsInFiles = function (txs, extraProps) {
    return Q.all(txs.map(function(tx) {
      _.extend(tx, extraProps);
      _.extend(tx, { currency: currency });
      return txsDAL.addLinked(new Transaction(tx));
    }));
  };

  function writeJSON(obj, fileName, done) {
    //console.log('Write %s', fileName);
    var fullPath = rootPath + '/' + fileName;
    return writeJSONToPath(obj, fullPath, done);
  }

  function writeJSONToPath(obj, fullPath, done) {
    return donable(Q.Promise(function(resolve, reject){
      writeFileFifo.push(function(writeFinished) {
        return myFS.write(fullPath, JSON.stringify(obj, null, ' '))
          .then(function(){
            resolve();
            writeFinished();
          })
          .fail(function(err){
            reject(err);
            writeFinished();
          });
      });
    }), done);
  }

  this.writeJSON = writeJSON;

  function donable(promise, done) {
    return promise
      .then(function(){
        done && done();
      })
      .fail(function(err){
        done && done(err);
        throw err;
      });
  }

  this.donable = donable;

  function blockFileName(blockNumber) {
    return BLOCK_FILE_PREFIX.substr(0, BLOCK_FILE_PREFIX.length - ("" + blockNumber).length) + blockNumber;
  }

  this.merkleForPeers = function(done) {
    return merkleDAL.getLeaves('peers')
      .then(function(leaves){
        var merkle = new Merkle();
        merkle.initialize(leaves);
        done && done(null, merkle);
        return merkle;
      })
      .fail(function(err){
        done && done(err);
        throw err;
      });
  };

  this.updateMerkleForPeers = function(done) {
    return that.findAllPeersNEWUPBut([])
      .then(function(peers){
        var merkle = new Merkle();
        var leaves = [];
        peers.forEach(function (p) {
          leaves.push(p.hash);
        });
        merkle.initialize(leaves);
        return merkle.leaves();
      })
      .then(function(leaves){
        return merkleDAL.pushMerkle('peers', leaves);
      })
      .then(function(){
        done && done();
      })
      .fail(function(err){
        done && done(err);
        throw err;
      });
  };

  this.saveLink = function(link, done) {
    links.push(link);
    return that.writeJSON(links, 'links.json', done);
  };

  this.saveSource = function(src, done) {
    sources.push(src);
    return (src.type == "D" ? that.saveUDInHistory(src.pubkey, src) : Q())
      .then(function(){
        return that.writeJSON(sources, 'sources.json', done);
      });
  };

  this.saveIdentity = function(idty, done) {
    var existing = _.where(identities, {
      pubkey: idty.pubkey,
      hash: idty.hash
    })[0];
    if (!existing) {
      idty.block_number = parseInt(idty.block_number);
      identities.push(idty);
    } else {
      idty.block_number = parseInt(idty.block_number);
      _.extend(existing, idty);
    }
    return saveIdentitiesInFile(identities, done);
  };

  function saveIdentitiesInFile(identities, done) {
    return that.writeJSON(identities.map(function(idty) {
      return _.omit(idty, 'certs');
    }), 'identities.json', function(err, obj) {
      done(err, obj);
    });
  }

  this.officializeCertification = function(cert) {
    return certDAL.saveOfficial(cert)
      .then(function(){
        return certDAL.removeNotLinked(cert);
      });
  };

  this.registerNewCertification = function(cert) {
    return certDAL.saveNewCertification(cert);
  };

  this.saveTransaction = function(tx) {
    return txsDAL.addPending(tx);
  };

  this.dropTxRecords = function() {
    return myFS.removeTree(rootPath + '/txs/');
  };

  this.saveUDInHistory = function(pubkey, ud) {
    return myFS.makeTree(rootPath + '/ud_history/')
      .then(function(){
        return myFS.read(rootPath + '/ud_history/' + pubkey + '.json')
          .then(function(data){
            return JSON.parse(data);
          });
      })
      .fail(function(){
        return { history: [] };
      })
      .then(function(obj){
        obj.history.push(new Source(ud).UDjson());
        return myFS.write(rootPath + '/ud_history/' + pubkey + '.json', JSON.stringify(obj, null, ' '));
      });
  };

  this.getTransactionsHistory = function(pubkey) {
    return Q({ sent: [], received: [] })
      .then(function(history){
        history.sending = [];
        history.receiving = [];
        return Q.all([
          txsDAL.getLinkedWithIssuer(pubkey),
          txsDAL.getLinkedWithRecipient(pubkey),
          txsDAL.getPendingWithIssuer(pubkey),
          txsDAL.getPendingWithRecipient(pubkey)
        ])
          .then(function(sent, received, sending, pending){
            history.sent = sent;
            history.received = received;
            history.sending = sending;
            history.pending = pending;
          }).thenResolve(history);
      });
  };

  this.getUDHistory = function(pubkey, done) {
    return myFS.makeTree(rootPath + '/ud_history/')
      .then(function(){
        return myFS.read(rootPath + '/ud_history/' + pubkey + '.json')
          .then(function(data){
            return JSON.parse(data);
          });
      })
      .fail(function(){
        return { history: [] };
      })
      .then(function(obj){
        obj.history = obj.history.map(function(src) {
          var completeSrc = _.extend({}, src);
          _.extend(completeSrc, _.findWhere(sources, { type: 'D', pubkey: pubkey, number: src.block_number }));
          return completeSrc;
        });
        done && done(null, obj);
        return obj;
      })
      .fail(function(err){
        done && done(err);
        throw err;
      });
  };

  this.savePeer = function(peer, done) {
    peer.hash = (sha1(peer.getRawSigned()) + "").toUpperCase();
    var existing = _.where(peers, { pubkey: peer.pubkey })[0];
    if (!existing) {
      peers.push(peer);
    } else {
      _.extend(existing, peer);
    }
    return that.writeJSON(peers, 'peers.json', done);
  };

  /***********************
   *    IO functions
   **********************/

  function ioRead(someFunction) {
    that.readFunctions.push(someFunction);
    return someFunction;
  }

  function ioWrite(someFunction) {
    that.writeFunctions.push(someFunction);
    return someFunction;
  }

  function existsFunc(filePath) {
    return myFS.exists(rootPath + '/' + filePath);
  }

  function listFunc(filePath) {
    return myFS.list(rootPath + '/' + filePath)
      .then(function(files){
        return files.map(function(fileName) {
          return { core: that.name, file: fileName };
        });
      })
      .fail(function() {
        return [];
      });
  }

  function readFunc(filePath) {
    return myFS.read(rootPath + '/' + filePath)
      .then(function(data){
        return JSON.parse(data);
      });
  }

  function writeFunc(filePath, what) {
    return myFS.write(rootPath + '/' + filePath, JSON.stringify(what, null, ' '));
  }

  function removeFunc(filePath, what) {
    return myFS.remove(rootPath + '/' + filePath, JSON.stringify(what, null, ' '));
  }

  function makeTreeFunc(filePath) {
    return myFS.makeTree(rootPath + '/' + filePath);
  }

  this.path = function(filePath) {
    return rootPath + '/' + filePath;
  };

  this.setExists = function(existsF) {
    dals.forEach(function(dal){
      dal.setExists(existsF);
    });
    that.existsFile = existsF;
  };

  this.setList = function(listF) {
    dals.forEach(function(dal){
      dal.setList(listF);
    });
    that.listFile = listF;
  };

  this.setRead = function(readF) {
    dals.forEach(function(dal){
      dal.setRead(readF);
    });
    that.readFile = readF;
  };

  this.setWrite = function(writeF) {
    dals.forEach(function(dal){
      dal.setWrite(writeF);
    });
    that.writeFile = writeF;
  };

  this.setRemove = function(removeF) {
    dals.forEach(function(dal){
      dal.setRemove(removeF);
    });
    that.removeFile = removeF;
  };

  this.setMakeTree = function(makeTreeF) {
    dals.forEach(function(dal){
      dal.setMakeTree(makeTreeF);
    });
    that.makeTreeFile = makeTreeF;
  };

  this.setExists(existsFunc);
  this.setList(listFunc);
  this.setRead(readFunc);
  this.setWrite(writeFunc);
  this.setRemove(removeFunc);
  this.setMakeTree(makeTreeFunc);

  /***********************
   *    CONFIGURATION
   **********************/

  this.loadConf = ioRead(function() {
    return confDAL.loadConf()
      .then(function(conf){
        currency = conf.currency;
        return conf;
      });
  });

  this.saveConf = ioWrite(function(confToSave) {
    currency = confToSave.currency;
    return confDAL.saveConf(confToSave);
  });

  /***********************
   *     STATISTICS
   **********************/

  this.loadStats = ioRead(statDAL.loadStats);
  this.getStat = ioRead(statDAL.getStat);
  this.saveStat = ioWrite(statDAL.saveStat);

  this.close = function() {
    // TODO
  };

  this.resetAll = function(done) {
    var files = ['peers', 'stats', 'sources', 'memberships', 'links', 'identities', 'global', 'merkles', 'conf'];
    var dirs  = ['tx', 'blocks', 'ud_history', 'branches', 'certs', 'txs', 'cores'];
    return resetFiles(files, dirs, done);
  };

  this.resetData = function(done) {
    var files = ['peers', 'stats', 'sources', 'memberships', 'links', 'identities', 'global', 'merkles'];
    var dirs  = ['tx', 'blocks', 'ud_history', 'branches', 'certs', 'txs', 'cores'];
    return resetFiles(files, dirs, done);
  };

  this.resetConf = function(done) {
    var files = ['conf'];
    var dirs  = [];
    return resetFiles(files, dirs, done);
  };

  this.resetStats = function(done) {
    var files = ['stats'];
    var dirs  = ['ud_history'];
    return resetFiles(files, dirs, done);
  };

  this.resetPeers = function(done) {
    var files = ['peers'];
    var dirs  = [];
    return resetFiles(files, dirs, done);
  };

  this.resetTransactions = function(done) {
    var files = [];
    var dirs  = ['txs'];
    return resetFiles(files, dirs, done);
  };

  function resetFiles(files, dirs, done) {
    return Q.all([

      // Remove files
      Q.all(files.map(function(fName) {
        return myFS.exists(rootPath + '/' + fName + '.json')
          .then(function(exists){
            return exists ? myFS.remove(rootPath + '/' + fName + '.json') : Q();
          })
      })),

      // Remove directories
      Q.all(dirs.map(function(dirName) {
        return myFS.exists(rootPath + '/' + dirName)
          .then(function(exists){
            return exists ? myFS.removeTree(rootPath + '/' + dirName) : Q();
          })
      }))
    ])
      .then(function(){
        done && done();
      })
      .fail(function(err){
        done && done(err);
      });
  }

  // INSTRUMENTALIZE ALL METHODS
  var f;
  for (f in this) {
    if (that.hasOwnProperty(f) && typeof that[f] == 'function') {
      (function() {
        var fname = f + "";
        var func = that[fname];
        func.surname = fname;
        // Instrumentalize the function
        that[fname] = function() {
          var args = arguments, start;
          //var start = new Date();
          return Q()
            .then(function(){
              return onceLoadedDAL();
            })
            .fail(function(err) {
              logger.error('Could not call %s()', fname);
              logger.error(err);
              if (typeof args[args.length - 1] == 'function') {
                args[args.length - 1](err);
              }
              throw err;
            })
            .then(function() {
              return Q()
                .then(function(){
                  //start = new Date();
                  //try {
                  //  //logger.debug('Call %s.%s(%s)', that.name, fname, JSON.stringify(args));
                  //}
                  //catch (e) {
                  //  //logger.error(e);
                  //  logger.debug('Call %s.%s(... [circular structure] ...)', that.name, fname);
                  //}
                  return func.apply(that, args);
                })
                // TODO: add a parameter to enable/disable performance logging
                .then(function (o) {
                  var duration = (new Date() - start);
                  if (duration >= constants.DEBUG.LONG_DAL_PROCESS)
                    logger.debug('Time %s ms | %s', duration, fname);
                  return o;
                })
                ;
            });
        };
        that[fname].now = function() {
          var args = arguments;
          //var start = new Date();
          return Q()
            .then(function(){
              return func.apply(that, args);
            })
            // TODO: add a parameter to enable/disable performance logging
            //.then(function (o) {
            //  var duration = (new Date() - start);
            //  //if (duration >= constants.DEBUG.LONG_DAL_PROCESS)
            //  //  logger.debug('Time %s ms | %s', duration, fname);
            //  return o;
            //})
          ;
        };
      })();
    }
  }
}
