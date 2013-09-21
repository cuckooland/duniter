var jpgp      = require('../lib/jpgp');
var async     = require('async');
var request   = require('request');
var mongoose  = require('mongoose');
var _         = require('underscore');
var THTEntry  = mongoose.model('THTEntry');
var Amendment = mongoose.model('Amendment');
var PublicKey = mongoose.model('PublicKey');
var Merkle    = mongoose.model('Merkle');
var Vote      = mongoose.model('Vote');
var Peer      = mongoose.model('Peer');
var Key       = mongoose.model('Key');
var Forward   = mongoose.model('Forward');

module.exports.get = function (pgp, currency, conf) {
  
  this.privateKey = pgp.keyring.privateKeys[0];
  this.ascciiPubkey = (pgp && pgp.keyring.privateKeys[0]) ? pgp.keyring.privateKeys[0].obj.extractPublicKey() : '';
  this.cert = this.ascciiPubkey ? jpgp().certificate(this.ascciiPubkey) : { fingerprint: '' };

  this.submit = function(signedPR, keyID, callback){
    var peer = new Peer();
    var that = this;
    async.waterfall([
      function (next){
        peer.parse(signedPR, next);
      },
      function (peer, next){
        peer.verify(currency, next);
      },
      // Looking for corresponding public key
      function(valid, next){
        if(!valid){
          next('Not a valid peering request');
          return;
        }
        require('request')('http://' + peer.getURL()+ '/ucg/pubkey', next);
      },
      function (httpRes, body, next){
        var cert = jpgp().certificate(body);
        if(!cert.fingerprint.match(new RegExp(keyID + "$", "g"))){
          next('Peer\'s public key ('+cert.fingerprint+') does not match signatory (0x' + keyID + ')');
          return;
        }
        if(!peer.fingerprint.match(new RegExp(keyID + "$", "g"))){
          next('Fingerprint in peering entry ('+cert.fingerprint+') does not match signatory (0x' + keyID + ')');
          return;
        }
        PublicKey.persistFromRaw(body, '', function (err) {
          next(err, body);
        });
      },
      function (pubkey, next){
        that.persistPeering(signedPR, pubkey, next);
      }
    ], callback);
  }

  this.persistPeering = function (signedPR, pubkey, done) {
    var peer = new Peer();
    async.waterfall([
      function (next){
        peer.parse(signedPR, next);
      },
      function (peer, next){
        peer.verify(currency, next);
      },
      function (verified, next) {
        peer.verifySignature(pubkey, next);
      },
      function (verified, next){
        if(!verified){
          next('Signature does not match');
          return;
        }
        next();
      },
      function (next){
        Peer.find({ fingerprint: peer.fingerprint }, next);
      },
      function (peers, next){
        var peerEntity = peer;
        var previousHash = null;
        if(peers.length > 0){
          // Already existing peer
          peerEntity = peers[0];
          previousHash = peerEntity.hash;
          peer.copyValues(peerEntity);
        }
        peerEntity.save(function (err) {
          next(err, peerEntity, previousHash);
        });
      },
      function (recordedPR, previousHash, next) {
        Merkle.updatePeers(recordedPR, previousHash, function (err, code, merkle) {
          next(err, recordedPR);
        });
      }
    ], done);
  }

  this.initKeys = function (done) {
    var manual = conf.kmanagement == 'KEYS';
    if(manual){
      done();
      return;
    }
    var thtKeys = [];
    var managedKeys = [];
    async.waterfall([
      function (next){
        Key.find({ managed: true });
      },
      function (keys, next) {
        keys.forEach(function (k) {
          managedKeys.push(k.fingerprint);
        });
        next();
      },
      function (next) {
        THTEntry.find({}, next);
      },
      function (entries, next) {
        entries.forEach(function (e) {
          thtKeys.push(e.fingerprint);
        });
        next();
      },
      function (next) {
        // Entries from THT not present in managedKeys
        var notManaged = _(thtKeys).difference(managedKeys) || [];
        next(null, notManaged);
      },
      function (notManaged, next) {
        async.forEachSeries(notManaged, function (key, callback) {
          console.log('Add %s to managed keys...', key);
          Key.setManaged(key, true, that.cert.fingerprint, callback);
        }, next);
      }
    ], done);
  }

  this.initForwards = function (done) {
    var manual = conf.kmanagement == 'KEYS';
    var that = this;
    if(manual){

      /**
      * Forward: KEYS
      * Send forwards only to concerned hosts
      */
      var keysByPeer = {};
      async.waterfall([
        function (next){
          Key.find({ managed: true }, next);
        },
        function (keys, next) {
          async.forEachSeries(keys, function (k, callback) {
            THTEntry.getTheOne(k.fingerprint, function (err, entry) {
              if(err){
                callback();
                return;
              }
              entry.hosters.forEach(function (peer) {
                keysByPeer[peer] = keysByPeer[peer] || [];
                keysByPeer[peer].push(k.fingerprint);
              });
              callback();
            });
          }, function (err) {
            async.forEach(_(keysByPeer).keys(), function(peerFPR, callback){
              var forward, peer;
              async.waterfall([
                function (next) {
                  if(peerFPR == that.cert.fingerprint){
                    next('Peer ' + peerFPR + ' : self');
                    return;
                  }
                  next();
                },
                function (next){
                  Peer.find({ fingerprint: peerFPR }, next);
                },
                function (peers, next) {
                  if(peers.length < 1){
                    next('Peer ' + peerFPR + ' : unknow yet');
                    return;
                  }
                  peer = peers[0];
                  next();
                },
                function (next) {
                  Forward.getTheOne(this.cert.fingerprint, peerFPR, next);
                },
                function (fwd, next) {
                  if(fwd.forward == 'KEYS' && _(keysByPeer[peerFPR]).difference(fwd.keys).length == 0){
                    next('Peer ' + peerFPR + ' : forward already sent');
                    return;
                  }
                  if(fwd._id){
                    fwd.remove(next);
                    return;
                  }
                  next();
                },
                function (next) {
                  forward = new Forward({
                    version: 1,
                    currency: currency,
                    from: that.cert.fingerprint,
                    to: peer.fingerprint,
                    forward: 'KEYS',
                    keys: keysByPeer[peerFPR]
                  });
                  jpgp().sign(forward.getRaw(), that.privateKey, function (err, signature) {
                    next(err, peer, forward.getRaw(), signature);
                  });
                },
                function (peer, rawForward, signature, next) {
                  sendForward(peer, rawForward, signature, function (err, res, body) {
                    if(!err && res && res.statusCode && res.statusCode == 404){
                      async.waterfall([
                        function (next){
                          Peer.find({ fingerprint: that.cert.fingerprint }, next);
                        },
                        function (peers, next) {
                          if(peers.length == 0){
                            next('Cannot send self-peering request: does not exist');
                            return;
                          }
                          sendPeering(peer, peers[0], next);
                        },
                        function (res, body, next) {
                          sendForward(peer, rawForward, signature, function (err, res, body) {
                            next(err);
                          });
                        }
                      ], next);
                    }
                    else if(!res) next('No HTTP result');
                    else if(!res.statusCode) next('No HTTP result code');
                    else next(err);
                  });
                },
                function (next) {
                  forward.save(next);
                },
              ], function (err) {
                if(err) console.error(err);
                callback();
              });
            }, next);
          });
        }
      ], done);
    }
    else{
      
      /**
      * Forward: ALL
      * Send simple ALL forward to every known peer
      */
      async.waterfall([
        function (next){
          Key.find({ managed: true });
        },
        function (keys, next) {
          async.forEachSeries(keys, function(peerFPR, callback){
            async.waterfall([
              function (next){
                Peer.find({ fingerprint: peerFPR }, next);
              },
              function (peers, next) {
                if(peers.length < 1){
                  next('Peer unknow yet')
                  return;
                }
                next(null, peers[0]);
              },
              function (peer, next) {
                var forward = new Forward({
                  version: 1,
                  currency: currency,
                  from: that.cert.fingerprint,
                  to: peer.fingerprint,
                  forward: 'ALL'
                });
                jpgp().sign(forward.getRaw(), that.privateKey, function (err, signature) {
                  next(err, peer, forward.getRaw(), signature);
                });
              },
              function (peer, rawForward, signature, next) {
                sendForward(peer, rawForward, signature, next);
              }
            ], function (err) {
              if(err) console.error(err);
              callback();
            });
          }, next);
        }
      ], done);
    }
  }

  function sendPeering(toPeer, peer, done) {
    post(toPeer, '/ucg/peering/peers', {
      "entry": peer.getRaw(),
      "signature": peer.signature
    }, done);
  }

  function sendForward(peer, rawForward, signature, done) {
    post(peer, '/ucg/peering/forward', {
      "forward": rawForward,
      "signature": signature
    }, done);
  }

  function post(peer, url, data, done) {
    console.log('http://' + peer.getURL() + url);
    request
    .post('http://' + peer.getURL() + url, done)
    .form(data);
  }

  function get(peer, url, done) {
    request
    .get('http://' + peer.getURL() + url)
    .end(done);
  }

  return this;
}