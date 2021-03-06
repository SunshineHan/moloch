/******************************************************************************/
/* pcap.js -- represent a pcap file
 *
 * Copyright 2012-2016 AOL Inc. All rights reserved.
 * 
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this Software except in compliance with the License.
 * You may obtain a copy of the License at
 * 
 *     http://www.apache.org/licenses/LICENSE-2.0
 * 
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/*jshint
  node: true, plusplus: false, curly: true, eqeqeq: true, immed: true, latedef: true, newcap: true, nonew: true, undef: true, strict: true, trailing: true
*/
'use strict';

var fs             = require('fs');

var Pcap = module.exports = exports = function Pcap (key) {
  this.key     = key;
  this.count   = 0;
  this.closing = false;
  return this;
};

var internals = {
  pr2name: {
    1:  "icmp",
    6:  "tcp",
    17: "udp",
    47: "gre",
    58: "icmpv6"
  },
  pcaps: {}
};

//////////////////////////////////////////////////////////////////////////////////
//// High Level
//////////////////////////////////////////////////////////////////////////////////
Pcap.prototype.ref = function() {
  this.count++;
};

exports.get = function(key) {
  if (internals.pcaps[key]) {
    return internals.pcaps[key];
  }

  var pcap = new Pcap(key);
  internals.pcaps[key] = pcap;
  return pcap;
};

exports.make = function(key, header) {
  var pcap = new Pcap(key);
  pcap.headBuffer = header;
  pcap.bigEndian  = pcap.headBuffer.readUInt32LE(0) === 0xd4c3b2a1;
  if (pcap.bigEndian) {
    pcap.linkType   = pcap.headBuffer.readUInt32BE(20);
  } else {
    pcap.linkType   = pcap.headBuffer.readUInt32LE(20);
  }
  return pcap;
}

Pcap.prototype.isOpen = function() {
  return this.fd !== undefined;
};

Pcap.prototype.open = function(filename) {
  if (this.fd) {
    return;
  }
  this.filename = filename;
  this.fd = fs.openSync(filename, "r");
  this.readHeader();
};

Pcap.prototype.openReadWrite = function(filename) {
  if (this.fd) {
    return;
  }
  this.filename = filename;
  this.fd = fs.openSync(filename, "r+");
};

Pcap.prototype.unref = function() {
  this.count--;
  if (this.count > 0) {
    return;
  }

  if (this.closing === true) {
    return;
  }

  var self = this;
  self.closing = true;

  setTimeout(function() {
    if (self.closing && self.count === 0) {
      delete internals.pcaps[self.key];
      if (self.fd) {
        fs.close(self.fd);
      }
      delete self.fd;
    } else {
      self.closing = false;
    }
  }, 500);
};

Pcap.prototype.readHeader = function(cb) {
  if (this.headBuffer) {
    if (cb) {
      cb(this.headBuffer);
    }
    return this.headBuffer;
  }

  this.headBuffer = new Buffer(24);
  fs.readSync(this.fd, this.headBuffer, 0, 24, 0);
  this.bigEndian  = this.headBuffer.readUInt32LE(0) === 0xd4c3b2a1;
  if (this.bigEndian) {
    this.linkType   = this.headBuffer.readUInt32BE(20);
  } else {
    this.linkType   = this.headBuffer.readUInt32LE(20);
  }

  if (cb) {
    cb(this.headBuffer);
  }
  return this.headBuffer;
};

Pcap.prototype.readPacket = function(pos, cb) {
  var self = this;

  // Hacky!! File isn't actually opened, try again soon
  if (!self.fd) {
    setTimeout(self.readPacket, 10, pos, cb);
    return;
  }

  var buffer = new Buffer(1550);
  try {

    // Try and read full packet and header in one read
    fs.read(self.fd, buffer, 0, buffer.length, pos, function (err, bytesRead, buffer) {
      if (bytesRead < 16) {
        return cb(null);
      }
      var len = (self.bigEndian?buffer.readUInt32BE(8):buffer.readUInt32LE(8));

      if (len < 0 || len > 0xffff) {
        return cb(undefined);
      }

      // Full packet fit
      if (16 + len <= bytesRead) {
          return cb(buffer.slice(0,16+len));
      }
      // Full packet didn't fit, get what was missed
      try {
        var b = new Buffer(16+len);
        buffer.copy(b, 0, 0, bytesRead);
        buffer = b;
        fs.read(self.fd, buffer, bytesRead, (16+len)-bytesRead, pos+bytesRead, function (err, bytesRead, buffer) {
          return cb(buffer.slice(0,16+len));
        });
      } catch (e) {
        console.log("Error ", e, "for file", self.filename);
        return cb (null);
      }
    });
  } catch (e) {
    console.log("Error ", e, "for file", self.filename);
    return cb (null);
  }
};

Pcap.prototype.scrubPacket = function(packet, pos, buf, entire) {

  var len = packet.pcap.incl_len + 16; // 16 = pcap header length
  if (entire) {
    pos += 16; // Don't delete pcap header
    len -= 16;
  } else {
    switch(packet.ip.p) {
    case 1:
      pos += (packet.icmp._pos + 8);
      len -= (packet.icmp._pos + 8);
      break;
    case 6:
      pos += (packet.tcp._pos + 4*packet.tcp.off);
      len -= (packet.tcp._pos + 4*packet.tcp.off);
      break;
    case 17:
      pos += (packet.udp._pos + 8);
      len -= (packet.udp._pos + 8);
      break;
    default:
      throw "Unknown packet type, can't scrub";
    }
  }

  fs.writeSync(this.fd, buf, 0, len, pos);
  fs.fsyncSync(this.fd);
};

//////////////////////////////////////////////////////////////////////////////////
//// Utilities
//////////////////////////////////////////////////////////////////////////////////

exports.protocol2Name = function(num) {
  return internals.pr2name[num] || "" + num;
};

exports.inet_ntoa = function(num) {
  return (num >> 24 & 0xff) + '.' + (num>>16 & 0xff) + '.' + (num>>8 & 0xff) + '.' + (num & 0xff);
};

//////////////////////////////////////////////////////////////////////////////////
//// Decode pcap buffers and build up simple objects
//////////////////////////////////////////////////////////////////////////////////


Pcap.prototype.icmp = function (buffer, obj, pos) {
  obj.icmp = {
    _pos:      pos,
    length:    buffer.length,
    type:      buffer[0],
    code:      buffer[1],
    sum:       buffer.readUInt16BE(2),
    id:        buffer.readUInt16BE(4),
    sequence:  buffer.readUInt16BE(6)
  };

  obj.icmp.data = buffer.slice(8);
};

Pcap.prototype.tcp = function (buffer, obj, pos) {
  obj.tcp = {
    _pos:       pos,
    length:     buffer.length,
    sport:      buffer.readUInt16BE(0),
    dport:      buffer.readUInt16BE(2),
    seq:        buffer.readUInt32BE(4),
    ack:        buffer.readUInt32BE(8),
    off:        ((buffer[12] >> 4) & 0xf),
    res1:       (buffer[12] & 0xf),
    flags:      buffer[13],
    res2:       (buffer[13] >> 6 & 0x3),
    urgflag:    (buffer[13] >> 5 & 0x1),
    ackflag:    (buffer[13] >> 4 & 0x1),
    pshflag:    (buffer[13] >> 3 & 0x1),
    rstflag:    (buffer[13] >> 2 & 0x1),
    synflag:    (buffer[13] >> 1 & 0x1),
    finflag:    (buffer[13] >> 0 & 0x1),
    win:        buffer.readUInt16BE(14),
    sum:        buffer.readUInt16BE(16),
    urp:        buffer.readUInt16BE(18)
  };

  if (4*obj.tcp.off > buffer.length) {
    obj.tcp.data = new Buffer(0);
  } else {
    obj.tcp.data = buffer.slice(4*obj.tcp.off);
  }
};

Pcap.prototype.udp = function (buffer, obj, pos) {
  obj.udp = {
    _pos:       pos,
    length:     buffer.length,
    sport:      buffer.readUInt16BE(0),
    dport:      buffer.readUInt16BE(2),
    ulen:       buffer.readUInt16BE(4),
    sum:        buffer.readUInt16BE(6)
  };

  obj.udp.data = buffer.slice(8);
};

Pcap.prototype.gre = function (buffer, obj, pos) {
  obj.gre = {
    flags_version: buffer.readUInt16BE(0),
    type:          buffer.readUInt16BE(2)
  };
  var bpos = 4;
  var offset = 0;
  if (obj.gre.flags_version & (0x8000 | 0x4000)) {
    bpos += 2;
    offset = buffer.readUInt16BE(bpos);
    bpos += 2;
  }

  // key
  if (obj.gre.flags_version & 0x2000) {
    bpos += 4;
  }

  // sequence number
  if (obj.gre.flags_version & 0x1000) {
    bpos += 4;
  }

  // routing
  if (obj.gre.flags_version & 0x4000) {
    bpos += 3;
    while (1) {
      var len = buffer.readUInt16BE(bpos);
      if (len === 0)
        break;
      bpos += len;
    }
  }
  this.ip4(buffer.slice(bpos), obj, pos+bpos);
};

Pcap.prototype.ip4 = function (buffer, obj, pos) {
  obj.ip = {
    length: buffer.length,
    hl:     (buffer[0] & 0xf),
    v:      ((buffer[0] >> 4) & 0xf),
    tos:    buffer[1],
    len:    buffer.readUInt16BE(2),
    id:     buffer.readUInt16BE(4),
    off:    buffer.readUInt16BE(6),
    ttl:    buffer[8],
    p:      buffer[9],
    sum:    buffer.readUInt16BE(10),
    addr1:  exports.inet_ntoa(buffer.readUInt32BE(12)),
    addr2:  exports.inet_ntoa(buffer.readUInt32BE(16))
  };

  switch(obj.ip.p) {
  case 1:
    this.icmp(buffer.slice(obj.ip.hl*4, obj.ip.len), obj, pos + obj.ip.hl*4);
    break;
  case 6:
    this.tcp(buffer.slice(obj.ip.hl*4, obj.ip.len), obj, pos + obj.ip.hl*4);
    break;
  case 17:
    this.udp(buffer.slice(obj.ip.hl*4, obj.ip.len), obj, pos + obj.ip.hl*4);
    break;
  case 47:
    this.gre(buffer.slice(obj.ip.hl*4, obj.ip.len), obj, pos + obj.ip.hl*4);
    break;
  default:
    console.log("Unknown ip.p", obj);
  }
};

Pcap.prototype.ip6 = function (buffer, obj, pos) {
  obj.ip = {
    length: buffer.length,
    v:      ((buffer[0] >> 4) & 0xf),
    tc:     ((buffer[0] & 0xf) << 4) | ((buffer[1] >> 4) & 0xf),
    flow:   ((buffer[1] & 0xf) << 16) | (buffer[2] << 8) | buffer[3],
    len:    buffer.readUInt16BE(4),
    p: buffer[6],
    hopLimt:  buffer[7],
    addr1:  buffer.slice(8,24).toString("hex"),
    addr2:  buffer.slice(24,40).toString("hex")
  };

  var offset = 40;
  while (offset < buffer.length) {
    switch(obj.ip.p) {
    case 0: //IPPROTO_HOPOPTS:
    case 60: //IPPROTO_DSTOPTS:
    case 43: //IPPROTO_ROUTING:
      obj.ip.p = buffer[offset];
      offset += ((buffer[offset+1] + 1) << 3);
      break;
    case 1:
    case 58:
      this.icmp(buffer.slice(offset, offset+obj.ip.len), obj, pos + offset);
      return;
    case 6:
      this.tcp(buffer.slice(offset, offset+obj.ip.len), obj, pos + offset);
      return;
    case 17:
      this.udp(buffer.slice(offset, offset+obj.ip.len), obj, pos + offset);
      return;
    default:
      console.log("Unknown ip.p", obj);
      return;
    }
  }
};

Pcap.prototype.pppoe = function (buffer, obj, pos) {
  obj.pppoe = {
    len:    buffer.readUInt16BE(4)-2,
    type:   buffer.readUInt16BE(6),
  };

  switch(obj.pppoe.type) {
  case 0x21:
    this.ip4(buffer.slice(8, 8+obj.pppoe.len), obj, pos + 8);
    return;
  case 0x57:
    this.ip6(buffer.slice(8, 8+obj.pppoe.len), obj, pos + 8);
    return;
  default:
    console.log("Unknown pppoe.type", obj);
    return;
  }
};

Pcap.prototype.ethertype = function(buffer, obj, pos) {
  obj.ether.type = buffer.readUInt16BE(0);

  switch(obj.ether.type) {
  case 0x0800:
    this.ip4(buffer.slice(2), obj, pos+2);
    break;
  case 0x86dd:
    this.ip6(buffer.slice(2), obj, pos+2);
    break;
  case 0x8864:
    this.pppoe(buffer.slice(2), obj, pos+2);
    break;
  case 0x8100: // VLAN
    this.ethertype(buffer.slice(4), obj, pos+4);
    break;
  default:
    console.trace("Unknown ether.type", obj);
    break;
  }
};

Pcap.prototype.ether = function (buffer, obj, pos) {
  obj.ether = {
    length: buffer.length,
    addr1:  buffer.slice(0, 6).toString('hex', 0, 6),
    addr2:  buffer.slice(6, 12).toString('hex', 0, 6)
  };
  this.ethertype(buffer.slice(12), obj, pos+12);
};


Pcap.prototype.pcap = function (buffer, obj) {
  if (this.bigEndian) {
    obj.pcap = {
      ts_sec:   buffer.readUInt32BE(0),
      ts_usec:  buffer.readUInt32BE(4),
      incl_len: buffer.readUInt32BE(8),
      orig_len: buffer.readUInt32BE(12)
    };
  } else {
    obj.pcap = {
      ts_sec:   buffer.readUInt32LE(0),
      ts_usec:  buffer.readUInt32LE(4),
      incl_len: buffer.readUInt32LE(8),
      orig_len: buffer.readUInt32LE(12)
    };
  }

  switch(this.linkType) {
  case 0: // NULL
    this.ip4(buffer.slice(20, obj.pcap.incl_len + 16), obj, 20);
    break;
  case 1: // Ether
    this.ether(buffer.slice(16, obj.pcap.incl_len + 16), obj, 16);
    break;
  case 12: // Raw
    this.ip4(buffer.slice(16, obj.pcap.incl_len + 16), obj, 16);
    break;
  case 113: // SLL
    this.ip4(buffer.slice(32, obj.pcap.incl_len + 16), obj, 32);
    break;
  default:
    console.log("Unsupported pcap file", this.filename, "link type", this.linkType);
    break;
  }
};

Pcap.prototype.decode = function (buffer, obj) {
  this.readHeader();
  this.pcap(buffer, obj);
};

Pcap.prototype.getHeaderNg = function () {

  var buffer = this.readHeader();
  var b = new Buffer(32 + 24);

  b.writeUInt32LE(0x0A0D0D0A, 0);  // Block Type
  b.writeUInt32LE(32, 4);          // Block Len 1
  b.writeUInt32LE(0x1A2B3C4D, 8);  // Byte Order Magic
  b.writeUInt16LE(1, 12);          // Major
  b.writeUInt16LE(0, 14);          // Minor
  b.writeUInt32LE(0xffffffff, 16); // Unknown Section Length 1
  b.writeUInt32LE(0xffffffff, 20); // Unknown Section Length 2
  b.writeUInt32LE(0, 24);          // Options
  b.writeUInt32LE(32, 28);         // Block Len 2


  b.writeUInt32LE(0x00000001, 32);              // Block Type
  b.writeUInt32LE(24, 36);                      // Block Len 1
  b.writeUInt16LE(buffer.readUInt32LE(20), 40); // Link Type
  b.writeUInt16LE(0, 42);                       // Reserved
  b.writeUInt32LE(buffer.readUInt32LE(16), 44); // SnapLen
  b.writeUInt32LE(0, 48);                       // Options
  b.writeUInt32LE(24, 52);                      // Block Len 2

  return b;
};

//////////////////////////////////////////////////////////////////////////////////
//// Reassembly array of packets
//////////////////////////////////////////////////////////////////////////////////

exports.reassemble_icmp = function (packets, cb) {
  var results = [];
  packets.forEach(function (item) {
    var key = item.ip.addr1;
    if (results.length === 0 || key !== results[results.length-1].key) {
      var result = {
        key: key,
        data: item.icmp.data,
        ts: item.pcap.ts_sec*1000 + Math.round(item.pcap.ts_usec/1000)
      };
      results.push(result);
    } else {
      var newBuf = new Buffer(results[results.length-1].data.length + item.icmp.data.length);
      results[results.length-1].data.copy(newBuf);
      item.icmp.data.copy(newBuf, results[results.length-1].data.length);
      results[results.length-1].data = newBuf;
    }
  });
  cb(null, results);
};

exports.reassemble_udp = function (packets, cb) {
  try {
  var results = [];
  packets.forEach(function (item) {
    var key = item.ip.addr1 + ':' + item.udp.sport;
    if (results.length === 0 || key !== results[results.length-1].key) {
      var result = {
        key: key,
        data: item.udp.data,
        ts: item.pcap.ts_sec*1000 + Math.round(item.pcap.ts_usec/1000)
      };
      results.push(result);
    } else {
      var newBuf = new Buffer(results[results.length-1].data.length + item.udp.data.length);
      results[results.length-1].data.copy(newBuf);
      item.udp.data.copy(newBuf, results[results.length-1].data.length);
      results[results.length-1].data = newBuf;
    }
  });
  cb(null, results);
  } catch (e) {
    cb(e, results);
  }
};

// Needs to be rewritten since its possible for packets to be
// dropped by windowing and other things to actually be displayed allowed.
// If multiple tcp sessions in one moloch session display can be wacky/wrong.
exports.reassemble_tcp = function (packets, skey, cb) {
  try {

    // Remove syn, rst, 0 length packets and figure out min/max seq number
    var packets2 = [];
    var info = {};
    var keys = [];
    var key, i, ilen;
    for (i = 0, ilen = packets.length; i < ilen; i++) {
      if (packets[i].tcp.data.length === 0 || packets[i].tcp.rstflag || packets[i].tcp.synflag) {
        continue;
      }
      key = packets[i].ip.addr1 + ':' + packets[i].tcp.sport;
      if (!info[key]) {
        info[key] = {min: packets[i].tcp.seq, max: packets[i].tcp.seq, wrapseq: false, wrapack: false};
        keys.push(key);
      }
      else if (info[key].min > packets[i].tcp.seq) {
        info[key].min = packets[i].tcp.seq;
      } else if (info[key].max < packets[i].tcp.seq) {
        info[key].max = packets[i].tcp.seq;
      }

      packets2.push(packets[i]);
    }
    packets = packets2;
    packets2 = [];

    if (packets.length === 0) {
        return cb(null, packets);
    }

    // Do we need to wrap the packets
    var needwrap = false;
    if (info[keys[0]] && info[keys[0]].max - info[keys[0]].min > 0x7fffffff) {
      info[keys[0]].wrapseq = true;
      info[keys[1]].wrapack = true;
      needwrap = true;
    }

    if (info[keys[1]] && info[keys[1]].max - info[keys[1]].min > 0x7fffffff) {
      info[keys[1]].wrapseq = true;
      info[keys[0]].wrapack = true;
      needwrap = true;
    }

    // Wrap the packets
    if (needwrap) {
      for (i = 0, ilen = packets.length; i < ilen; i++) {
        key = packets[i].ip.addr1 + ':' + packets[i].tcp.sport;
        if (info[key].wrapseq && packets[i].tcp.seq < 0x7fffffff) {
          packets[i].tcp.seq += 0xffffffff;
        }

        if (info[key].wrapack && packets[i].tcp.ack < 0x7fffffff) {
          packets[i].tcp.ack += 0xffffffff;
        }
      }
    }

    // Sort Packets
    var clientKey = packets[0].ip.addr1 + ':' + packets[0].tcp.sport;
    packets.sort(function(a,b) {
      if ((a.ip.addr1 === b.ip.addr1) && (a.tcp.sport === b.tcp.sport)) {
        return (a.tcp.seq - b.tcp.seq);
      }

      if (clientKey === a.ip.addr1 + ':' + a.tcp.sport) {
        return ((a.tcp.seq + a.tcp.data.length-1) - b.tcp.ack);
      }

      return (a.tcp.ack - (b.tcp.seq + b.tcp.data.length-1) );
    });

    // Now divide up conversation
    var clientSeq = 0;
    var hostSeq = 0;
    var start = 0;
    var previous = 0;

    var results = [];
    packets.forEach(function (item) {
      var key = item.ip.addr1 + ':' + item.tcp.sport;
      if (key === clientKey) {
        if (clientSeq >= (item.tcp.seq + item.tcp.data.length)) {
          return;
        }
        clientSeq = (item.tcp.seq + item.tcp.data.length);
      } else {
        if (hostSeq >= (item.tcp.seq + item.tcp.data.length)) {
          return;
        }
        hostSeq = (item.tcp.seq + item.tcp.data.length);
      }

      var result;
      if (results.length === 0 || key !== results[results.length-1].key) {
        previous = start = item.tcp.seq;
        result = {
          key: key,
          data: item.tcp.data,
          ts: item.pcap.ts_sec*1000 + Math.round(item.pcap.ts_usec/1000)
        };
        results.push(result);
      } else if (item.tcp.seq - previous > 0xffff) {
        results.push({key: "", data: new Buffer(0), ts: item.pcap.ts_sec*1000 + Math.round(item.pcap.ts_usec/1000)});
        // Larger then max window size packets missing
        previous = start = item.tcp.seq;
        result = {
          key: key,
          data: item.tcp.data,
          ts: item.pcap.ts_sec*1000 + Math.round(item.pcap.ts_usec/1000)
        };
        results.push(result);
      } else {
        previous = item.tcp.seq;
        var newBuf = new Buffer(item.tcp.data.length + item.tcp.seq - start);
        results[results.length-1].data.copy(newBuf);
        item.tcp.data.copy(newBuf, item.tcp.seq - start);
        results[results.length-1].data = newBuf;
      }
    });

    if (skey !== results[0].key) {
      results.unshift({data: new Buffer(0), key: skey});
    }
    cb(null, results);
  } catch (e) {
    cb(e, null);
  }
};
