"use strict";
var co             = require('co');
var util           = require('util');
var async          = require('async');
var _              = require('underscore');
var Q              = require('q');
var events         = require('events');
var crypto         = require('../lib/crypto');
var logger         = require('../lib/logger')('peering');
var base58         = require('../lib/base58');
var dos2unix       = require('../lib/dos2unix');
var hashf          = require('../lib/hashf');
var rawer          = require('../lib/rawer');
var pulling        = require('../lib/pulling');
var constants      = require('../lib/constants');
var Peer           = require('../lib/entity/peer');
var Transaction    = require('../lib/entity/transaction');
var AbstractService = require('./AbstractService');

const DONT_IF_MORE_THAN_FOUR_PEERS = true;

function PeeringService(server) {

  AbstractService.call(this);
  let conf, dal, pair, selfPubkey, SYNC_BLOCK_INTERVAL;

  this.setConfDAL = (newConf, newDAL, newPair) => {
    dal = newDAL;
    conf = newConf;
    pair = newPair;
    this.pubkey = base58.encode(pair.publicKey);
    selfPubkey = this.pubkey;
    SYNC_BLOCK_INTERVAL = conf.avgGenTime * constants.NETWORK.SYNC_BLOCK_INTERVAL;
  };

  var peer = null;
  var that = this;

  this.peer = (newPeer) => co(function *() {
    if (newPeer) {
      peer = newPeer;
    }
    let thePeer = peer;
    if (!thePeer) {
      thePeer = yield that.generateSelfPeer(conf, 0);
    }
    return Peer.statics.peerize(thePeer);
  });

  this.checkPeerSignature = function (p) {
    var raw = rawer.getPeerWithoutSignature(p);
    var sig = p.signature;
    var pub = p.pubkey;
    var signaturesMatching = crypto.verify(raw, sig, pub);
    return !!signaturesMatching;
  };

  this.submitP = function(peering, eraseIfAlreadyRecorded, cautious){
    let thePeer = new Peer(peering);
    let sp = thePeer.block.split('-');
    let blockNumber = parseInt(sp[0]);
    let blockHash = sp[1];
    let sigTime = 0;
    let block;
    let makeCheckings = cautious || cautious === undefined;
    return that.pushFIFO(() => co(function *() {
      if (makeCheckings) {
        let goodSignature = that.checkPeerSignature(thePeer);
        if (!goodSignature) {
          throw 'Signature from a peer must match';
        }
      }
      if (thePeer.block == constants.PEER.SPECIAL_BLOCK) {
        thePeer.statusTS = 0;
        thePeer.status = 'UP';
      } else {
        block = yield dal.getBlockByNumberAndHashOrNull(blockNumber, blockHash);
        if (!block && makeCheckings) {
          throw constants.ERROR.PEER.UNKNOWN_REFERENCE_BLOCK;
        } else if (!block) {
          thePeer.block = constants.PEER.SPECIAL_BLOCK;
          thePeer.statusTS = 0;
          thePeer.status = 'UP';
        }
      }
      sigTime = block ? block.medianTime : 0;
      thePeer.statusTS = sigTime;
      let found = yield dal.getPeerOrNull(thePeer.pubkey);
      var peerEntity = Peer.statics.peerize(found || thePeer);
      if(found){
        // Already existing peer
        var sp2 = found.block.split('-');
        var previousBlockNumber = parseInt(sp2[0]);
        if(blockNumber <= previousBlockNumber && !eraseIfAlreadyRecorded){
          throw constants.ERROR.PEER.ALREADY_RECORDED;
        }
        peerEntity = Peer.statics.peerize(found);
        thePeer.copyValues(peerEntity);
        peerEntity.sigDate = new Date(sigTime * 1000);
      }
      // Set the peer as UP again
      peerEntity.status = 'UP';
      peerEntity.first_down = null;
      peerEntity.last_try = null;
      peerEntity.hash = String(hashf(peerEntity.getRawSigned())).toUpperCase();
      peerEntity.raw = peerEntity.getRaw();
      yield dal.savePeer(peerEntity);
      return Peer.statics.peerize(peerEntity);
    }));
  };

  var peerFifo = async.queue(function (task, callback) {
    task(callback);
  }, 1);
  var peerInterval = null;
  this.regularPeerSignal = function (done) {
    let signalTimeInterval = 1000 * conf.avgGenTime * constants.NETWORK.STATUS_INTERVAL.UPDATE;
    if (peerInterval)
      clearInterval(peerInterval);
    peerInterval = setInterval(function () {
      peerFifo.push(_.partial(generateSelfPeer, conf, signalTimeInterval));
    }, signalTimeInterval);
    generateSelfPeer(conf, signalTimeInterval, done);
  };

  var crawlPeersFifo = async.queue((task, callback) => task(callback), 1);
  var crawlPeersInterval = null;
  this.regularCrawlPeers = function (done) {
    if (crawlPeersInterval)
      clearInterval(crawlPeersInterval);
    crawlPeersInterval = setInterval(()  => crawlPeersFifo.push(crawlPeers), 1000 * conf.avgGenTime * constants.NETWORK.SYNC_PEERS_INTERVAL);
    crawlPeers(DONT_IF_MORE_THAN_FOUR_PEERS, done);
  };

  let askedCancel = false;
  let currentSyncP = Q();
  var syncBlockFifo = async.queue((task, callback) => task(callback), 1);
  var syncBlockInterval = null;
  this.regularSyncBlock = function (done) {
    if (syncBlockInterval)
      clearInterval(syncBlockInterval);
    syncBlockInterval = setInterval(()  => syncBlockFifo.push(syncBlock), 1000 * SYNC_BLOCK_INTERVAL);
    syncBlock(done);
  };

  this.pullBlocks = (pubkey) => syncBlock(null, pubkey);

  const FIRST_CALL = true;
  var testPeerFifo = async.queue((task, callback) => task(callback), 1);
  var testPeerFifoInterval = null;
  this.regularTestPeers = function (done) {
    if (testPeerFifoInterval)
      clearInterval(testPeerFifoInterval);
    testPeerFifoInterval = setInterval(() => testPeerFifo.push(testPeers.bind(null, !FIRST_CALL)), 1000 * constants.NETWORK.TEST_PEERS_INTERVAL);
    testPeers(FIRST_CALL, done);
  };

  this.stopRegular = () => {
    askedCancel = true;
    clearInterval(peerInterval);
    clearInterval(crawlPeersInterval);
    clearInterval(syncBlockInterval);
    clearInterval(testPeerFifoInterval);
    peerFifo.kill();
    crawlPeersFifo.kill();
    syncBlockFifo.kill();
    testPeerFifo.kill();
    return co(function *() {
      yield currentSyncP;
      askedCancel = false;
    });
  };

  this.generateSelfPeer = generateSelfPeer;

  function generateSelfPeer(theConf, signalTimeInterval, done) {
    return co(function *() {
      try {

        let current = yield server.dal.getCurrentBlockOrNull();
        let currency = theConf.currency;
        let peers = yield dal.findPeers(selfPubkey);
        let p1 = { version: constants.DOCUMENTS_VERSION, currency: currency };
        if(peers.length != 0){
          p1 = _(peers[0]).extend({ version: constants.DOCUMENTS_VERSION, currency: currency });
        }
        let endpoint = 'BASIC_MERKLED_API';
        if (theConf.remotehost) {
          endpoint += ' ' + theConf.remotehost;
        }
        if (theConf.remoteipv4) {
          endpoint += ' ' + theConf.remoteipv4;
        }
        if (theConf.remoteipv6) {
          endpoint += ' ' + theConf.remoteipv6;
        }
        if (theConf.remoteport) {
          endpoint += ' ' + theConf.remoteport;
        }
        if (!currency || endpoint == 'BASIC_MERKLED_API') {
          logger.error('It seems there is an issue with your configuration.');
          logger.error('Please restart your node with:');
          logger.error('$ ucoind restart');
          return Q.Promise((resolve) => null);
        }
        // Choosing next based-block for our peer record: we basically want the most distant possible from current
        let minBlock = current ? current.number - 30 : 0;
        // But if already have a peer record within this distance, we need to take the next block of it
        if (p1) {
          let p1Block = parseInt(p1.block.split('-')[0], 10);
          minBlock = Math.max(minBlock, p1Block + 1);
        }
        // Finally we can't have a negative block
        minBlock = Math.max(0, minBlock);
        let targetBlock = yield server.dal.getBlockOrNull(minBlock);
        var p2 = {
          version: constants.DOCUMENTS_VERSION,
          currency: currency,
          pubkey: selfPubkey,
          block: targetBlock ? [targetBlock.number, targetBlock.hash].join('-') : constants.PEER.SPECIAL_BLOCK,
          endpoints: [endpoint]
        };
        var raw2 = dos2unix(new Peer(p2).getRaw());
        logger.info('External access:', new Peer(p2).getURL());
        logger.debug('Generating server\'s peering entry based on block#%s...', p2.block.split('-')[0]);
        p2.signature = yield Q.nfcall(server.sign, raw2);
        p2.pubkey = selfPubkey;
        p2.documentType = 'peer';
        // Submit & share with the network
        yield server.submitP(p2, false);
        let selfPeer = yield dal.getPeer(selfPubkey);
        // Set peer's statut to UP
        selfPeer.documentType = 'selfPeer';
        yield that.peer(selfPeer);
        server.streamPush(selfPeer);
        logger.info("Next peering signal in %s min", signalTimeInterval / 1000 / 60);
        done && done();
        return selfPeer;
      } catch(e) {
        if (done) return done(e);
        throw e;
      }
    });
  }

  function crawlPeers(dontCrawlIfEnoughPeers, done) {
    if (arguments.length == 1) {
      done = dontCrawlIfEnoughPeers;
      dontCrawlIfEnoughPeers = false;
    }
    logger.info('Crawling the network...');
    return co(function *() {
      let peers = yield dal.listAllPeersWithStatusNewUPWithtout(selfPubkey);
      if (peers.length > constants.NETWORK.COUNT_FOR_ENOUGH_PEERS && dontCrawlIfEnoughPeers == DONT_IF_MORE_THAN_FOUR_PEERS) {
        return;
      }
      let peersToTest = peers.slice().map((p) => Peer.statics.peerize(p));
      let tested = [];
      let found = [];
      while (peersToTest.length > 0) {
        let results = yield peersToTest.map(crawlPeer);
        tested = tested.concat(peersToTest.map((p) => p.pubkey));
        // End loop condition
        peersToTest.splice(0);
        // Eventually continue the loop
        for (let i = 0, len = results.length; i < len; i++) {
          let res = results[i];
          for (let j = 0, len2 = res.length; j < len2; j++) {
            try {
              let subpeer = res[j].leaf.value;
              if (subpeer.currency && tested.indexOf(subpeer.pubkey) === -1) {
                let p = Peer.statics.peerize(subpeer);
                peersToTest.push(p);
                found.push(p);
              }
            } catch (e) {
              logger.warn('Invalid peer %s', res[j]);
            }
          }
        }
        // Make unique list
        peersToTest = _.uniq(peersToTest, false, (p) => p.pubkey);
      }
      logger.info('Crawling done.');
      for (let i = 0, len = found.length; i < len; i++) {
        let p = found[i];
        try {
          // Try to write it
          p.documentType = 'peer';
          yield server.singleWritePromise(p);
        } catch(e) {
          // Silent error
        }
      }
    })
      .then(() => done()).catch(done);
  }

  function crawlPeer(aPeer) {
    return co(function *() {
      let subpeers = [];
      try {
        logger.debug('Crawling peers of %s %s', aPeer.pubkey.substr(0, 6), aPeer.getNamedURL());
        let node = yield aPeer.connectP();
        yield checkPeerValidity(aPeer, node);
        //let remotePeer = yield Q.nbind(node.network.peering.get)();
        let json = yield Q.nbind(node.network.peering.peers.get, node)({ leaves: true });
        for (let i = 0, len = json.leaves.length; i < len; i++) {
          let leaf = json.leaves[i];
          let subpeer = yield Q.nbind(node.network.peering.peers.get, node)({ leaf: leaf });
          subpeers.push(subpeer);
        }
        return subpeers;
      } catch (e) {
        return subpeers;
      }
    });
  }

  function testPeers(displayDelays, done) {
    return co(function *() {
      let peers = yield dal.listAllPeers();
      let now = (new Date().getTime());
      peers = _.filter(peers, (p) => p.pubkey != selfPubkey);
      for (let i = 0, len = peers.length; i < len; i++) {
        let p = new Peer(peers[i]);
        if (p.status == 'DOWN') {
          let shouldDisplayDelays = displayDelays;
          let downAt = p.first_down || now;
          let waitRemaining = getWaitRemaining(now, downAt, p.last_try);
          let nextWaitRemaining = getWaitRemaining(now, downAt, now);
          let testIt = waitRemaining <= 0;
          if (testIt) {
            // We try to reconnect only with peers marked as DOWN
            try {
              logger.trace('Checking if node %s is UP... (%s:%s) ', p.pubkey.substr(0, 6), p.getHostPreferDNS(), p.getPort());
              // We register the try anyway
              yield dal.setPeerDown(p.pubkey);
              // Now we test
              let node = yield Q.nfcall(p.connect);
              let peering = yield Q.nfcall(node.network.peering.get);
              yield checkPeerValidity(p, node);
              // The node answered, it is no more DOWN!
              logger.info('Node %s (%s:%s) is UP!', p.pubkey.substr(0, 6), p.getHostPreferDNS(), p.getPort());
              yield dal.setPeerUP(p.pubkey);
              // We try to forward its peering entry
              let sp1 = peering.block.split('-');
              let currentBlockNumber = sp1[0];
              let currentBlockHash = sp1[1];
              let sp2 = peering.block.split('-');
              let blockNumber = sp2[0];
              let blockHash = sp2[1];
              if (!(currentBlockNumber == blockNumber && currentBlockHash == blockHash)) {
                // The peering changed
                yield that.submitP(peering);
              }
              // Do not need to display when next check will occur: the node is now UP
              shouldDisplayDelays = false;
            } catch (err) {
              // Error: we set the peer as DOWN
              logger.trace("Peer %s is DOWN (%s)", p.pubkey, (err.httpCode && 'HTTP ' + err.httpCode) || err.code || err.message || err);
              yield dal.setPeerDown(p.pubkey);
              shouldDisplayDelays = true;
            }
          }
          if (shouldDisplayDelays) {
            logger.debug('Will check that node %s (%s:%s) is UP in %s min...', p.pubkey.substr(0, 6), p.getHostPreferDNS(), p.getPort(), (nextWaitRemaining / 60).toFixed(0));
          }
        }
      }
      done();
    })
      .catch(done);
  }

  function getWaitRemaining(now, downAt, last_try) {
    let downDelay = Math.floor((now - downAt) / 1000);
    let waitedSinceLastTest = Math.floor((now - (last_try || now)) / 1000);
    let waitRemaining = 1;
    if (downDelay <= constants.DURATIONS.A_MINUTE) {
      waitRemaining = constants.DURATIONS.TEN_SECONDS - waitedSinceLastTest;
    }
    else if (downDelay <= constants.DURATIONS.TEN_MINUTES) {
      waitRemaining = constants.DURATIONS.A_MINUTE - waitedSinceLastTest;
    }
    else if (downDelay <= constants.DURATIONS.AN_HOUR) {
      waitRemaining = constants.DURATIONS.TEN_MINUTES - waitedSinceLastTest;
    }
    else if (downDelay <= constants.DURATIONS.A_DAY) {
      waitRemaining = constants.DURATIONS.AN_HOUR - waitedSinceLastTest;
    }
    else if (downDelay <= constants.DURATIONS.A_WEEK) {
      waitRemaining = constants.DURATIONS.A_DAY - waitedSinceLastTest;
    }
    else if (downDelay <= constants.DURATIONS.A_MONTH) {
      waitRemaining = constants.DURATIONS.A_WEEK - waitedSinceLastTest;
    }
    // Else do not check it, DOWN for too long
    return waitRemaining;
  }

  function checkPeerValidity(p, node) {
    return co(function *() {
      try {
        let document = yield Q.nfcall(node.network.peering.get);
        let thePeer = Peer.statics.peerize(document);
        let goodSignature = that.checkPeerSignature(thePeer);
        if (!goodSignature) {
          throw 'Signature from a peer must match';
        }
        if (p.currency !== thePeer.currency) {
          throw 'Currency has changed from ' + p.currency + ' to ' + thePeer.currency;
        }
        if (p.pubkey !== thePeer.pubkey) {
          throw 'Public key of the peer has changed from ' + p.pubkey + ' to ' + thePeer.pubkey;
        }
        let sp1 = p.block.split('-');
        let sp2 = thePeer.block.split('-');
        let blockNumber1 = parseInt(sp1[0]);
        let blockNumber2 = parseInt(sp2[0]);
        if (blockNumber2 < blockNumber1) {
          throw 'Signature date has changed from block ' + blockNumber1 + ' to older block ' + blockNumber2;
        }
      } catch (e) {
        logger.warn(e);
        throw { code: "E_DUNITER_PEER_CHANGED" };
      }
    });
  }

  function syncBlock(callback, pubkey) {
    currentSyncP = co(function *() {
      let current = yield dal.getCurrentBlockOrNull();
      if (current) {
        logger.info("Pulling blocks from the network...");
        let peers = yield dal.findAllPeersNEWUPBut([selfPubkey]);
        peers = _.shuffle(peers);
        if (pubkey) {
          _(peers).filter((p) => p.pubkey == pubkey);
        }
        for (let i = 0, len = peers.length; i < len; i++) {
          let p = new Peer(peers[i]);
          logger.trace("Try with %s %s", p.getURL(), p.pubkey.substr(0, 6));
          try {
            let node = yield Q.nfcall(p.connect);
            node.pubkey = p.pubkey;
            yield checkPeerValidity(p, node);
            let dao = pulling.abstractDao({

              // Get the local blockchain current block
              localCurrent: () => dal.getCurrentBlockOrNull(),

              // Get the remote blockchain (bc) current block
              remoteCurrent: (thePeer) => Q.nfcall(thePeer.blockchain.current),

              // Get the remote peers to be pulled
              remotePeers: () => Q([node]),

              // Get block of given peer with given block number
              getLocalBlock: (number) => dal.getBlockOrNull(number),

              // Get block of given peer with given block number
              getRemoteBlock: (thePeer, number) => co(function *() {
                let block = null;
                try {
                  block = yield Q.nfcall(thePeer.blockchain.block, number);
                  Transaction.statics.setIssuers(block.transactions);
                  return block;
                } catch (e) {
                  if (e.httpCode != 404) {
                    throw e;
                  }
                }
                return block;
              }),

              // Simulate the adding of a single new block on local blockchain
              applyMainBranch: (block) => co(function *() {
                let addedBlock = yield server.BlockchainService.submitBlock(block, true, constants.FORK_ALLOWED);
                server.streamPush(addedBlock);
              }),

              // Eventually remove forks later on
              removeForks: () => Q(),

              // Tells wether given peer is a member peer
              isMemberPeer: (thePeer) => co(function *() {
                let idty = yield dal.getWrittenIdtyByPubkey(thePeer.pubkey);
                return (idty && idty.member) || false;
              }),

              // Simulates the downloading of blocks from a peer
              downloadBlocks: (thePeer, fromNumber, count) => Q.nfcall(thePeer.blockchain.blocks, count, fromNumber)
            });

            yield pulling.pull(conf, dao);
            
            // To stop the processing
            if (askedCancel) {
              len = 0;
            }
          } catch (e) {
            if (isConnectionError(e)) {
              logger.info("Peer %s unreachable: now considered as DOWN.", p.pubkey);
              yield dal.setPeerDown(p.pubkey);
            }
            else if (e.httpCode == 404) {
              logger.trace("No new block from %s %s", p.pubkey.substr(0, 6), p.getURL());
            }
            else {
              logger.warn(e);
            }
          }
        }
      }
      logger.info('Will pull blocks from the network in %s min %s sec', Math.floor(SYNC_BLOCK_INTERVAL / 60), Math.floor(SYNC_BLOCK_INTERVAL % 60));
      callback && callback();
    })
      .catch((err) => {
        logger.warn(err.code || err.stack || err.message || err);
        callback && callback();
      });
    return currentSyncP;
  }

  function isConnectionError(err) {
    return err && (
      err.code == "E_DUNITER_PEER_CHANGED"
      || err.code == "EINVAL"
      || err.code == "ECONNREFUSED"
      || err.code == "ETIMEDOUT"
      || (err.httpCode !== undefined && err.httpCode !== 404));
  }
}

util.inherits(PeeringService, events.EventEmitter);

module.exports = function (server, pair, dal) {
  return new PeeringService(server, pair, dal);
};
