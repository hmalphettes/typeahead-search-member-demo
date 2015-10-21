/**
 * Track the collected slips
 */

'use strict';
// var pg = require('pg');
// const conString = require('./searchable-datasets').conString;
const pool = require('./searchable-datasets').pool;
const _lazyCreate = require('./searchable-datasets')._lazyCreate;
const tableName = require('./searchable-datasets').tableName;

module.exports = {reset: reset, pcheck: pcheck, pcollect: pcollect};

function pcheck(newmemberid) {
  return new Promise(function(accept, reject) {
    // get a pg client from the connection pool
    pool.getConnection(function(err, connection) {
      if(err) { return reject(err); }
      connection.query('SELECT newmemberid,proxyid,desk,timestamp,photo FROM '+tableName+' WHERE newmemberid='+newmemberid, function(err, res) {
        connection.release();
        if (err) { return reject(err); }
        accept(res);
      });
    });
  });
}

function pcollect(newmemberid, proxyid, desk, photo) {
  return new Promise(function(accept, reject) {
    // get a mysql client from the connection pool
    pool.getConnection(function(err, connection) {
      if(err) { return reject(err); }
      const query = "INSERT INTO " + tableName + " (newmemberid, proxyid, desk, photo)" +
        "VALUES (" + newmemberid + ", " + proxyid + ", '" + desk + "', '" + photo + "')";
      connection.query(query, function (err /*, res*/) {
        connection.release();
        if (err) { return reject(err); }
        accept();
      });
    });
  });
}

function reset(done) {
  pool.getConnection(function(err, connection) {
    if(err) { return done(err); }
    connection.query('DROP TABLE IF EXISTS ' + tableName, function(err) {
      if (err) { return done(err); }
      _lazyCreate(connection, tableName, function(err, res) {
        connection.release();
        done(err, res);
      });
    });
  });
}
