'use strict';

const mysql = require('mysql');
const pool  = mysql.createPool({
  connectionLimit : 10,
  host     : process.env.MYSQL_HOST     || 'localhost',
  user     : process.env.MYSQL_USER     || 'root',
  password : process.env.MYSQL_PASSWORD || undefined,
  database : process.env.MYSQL_DATABASE || 'orpc'
});

// Name of the database table where the attendance is recorded.
const tableName = process.env.MYSQL_VOTING_SESSION_TABLE || 'votingslip';

const full = "replace(concat_ws(' ', famname, firstname, middlename, preferredname, DATE_FORMAT(birthdate,'%Y/%m/%d'), nric, mbrstatus), '  ', ' ')";
function makeQuery(columnToSearch) {
  var searched = columnToSearch !== 'newmemberid' ? columnToSearch : full;
  return 'SELECT CAST(newmemberid as UNSIGNED) as id, ' + searched +' AS value FROM orpcexcel';
}

/**
 * Returns datasets in a format that can be processed by typeahead's bloodhound.
 */
function getDatasets(searchableColumns, done) {
  var idx = -1;
  const datasets = [];
  var connection;
  var quorum;
  pool.getConnection(function(err, _connection) {
    if(err) { return done(err); }
    connection = _connection;
    _lazyCreateAttendanceTable(connection, tableName, function() {
      _countBaseQuorum(connection, function(err, _quorum) {
        if (err) {
          connection.release();
          return done(err);
        }
        quorum = _quorum;
        fetchOne();
      });
    });
  });

  function fetchOne() {
    idx++;
    var col = searchableColumns[idx];
    if (!col) {
      connection.release();
      return setImmediate(function() { done(null, datasets, quorum); });
    }
    fetchSearchableRows(connection, col, function(err, res) {
      if (err) {
        connection.release();
        return done(err);
      }
      datasets.push(res);
      setImmediate(fetchOne);
    });
  }
}

function fetchSearchableRows(connection, columnToSearch, done) {
  const query = makeQuery(columnToSearch);
  // console.log(query);
  connection.query(query, function(err, res) {
    // console.log('-->', err, res);
    if (err) { return done(err); }
    done(null, res);
  });
}

function _lazyCreateAttendanceTable(connection, tableName, done) {
  connection.query('CREATE TABLE IF NOT EXISTS ' + tableName + ' (newmemberid integer PRIMARY KEY,'+
  ' proxyid INTEGER, timestamp TIMESTAMP default current_timestamp, '+
  'desk VARCHAR(64), photo LONGTEXT, mbrstatus VARCHAR(80))', function (err, res) {
    done(err, res);
  });
}

/**
 * Count the number of active members.
 * We will need to the members that although Inactive actually ended up voting.
 */
function _countBaseQuorum(connection, done) {
  connection.query("SELECT COUNT(*) FROM orpcexcel WHERE MbrStatus = 'Active'" +
      " AND membertype NOT LIKE '%infant%'" +
      " AND membertype NOT LIKE '%transfer%out%'", function(err, res) {
    if (res && Array.isArray(res) && res.length === 1) {
      return done(null, _extractCountResult(res));
    }
    return done(err || new Error('Unexpected result'));
  });
}

/**
 * - Count the number of members who collected a slip.
 * - Count the number of members who collected a slip and are not marked as 'Active' so we can add them to the base quorum.
 */
function countCollectionsAndExtraQuorum(done) {
  pool.getConnection(function(err, connection) {
    if(err) { return done(err); }
    connection.query("SELECT COUNT(*) FROM "+tableName+" WHERE NOT MbrStatus = 'Active'", function(err, res) {
      if (res && Array.isArray(res) && res.length === 1) {
        var nonActiveMembersVotingCount = _extractCountResult(res);
        return connection.query("SELECT COUNT(*) FROM "+tableName, function(err, res) {
          var collectedCount = _extractCountResult(res);
          connection.release();
          return done(null, collectedCount, nonActiveMembersVotingCount);
        });
      }
      connection.release();
      return done(err || new Error('Unexpected result'));
    });
  });
}

function _extractCountResult(res) {
  if (res && Array.isArray(res) && res.length === 1) {
    for (var k in res[0]) {
      if (k.toLowerCase().indexOf('count') !== -1) {
        return res[0][k];
      }
    }
    return console.error('Could not read the result of the COUNT in ' + JSON.stringify(res));
  }
}

module.exports = {
  tableName: tableName,
  getDatasets: getDatasets,
  pool: pool,
  _lazyCreateAttendanceTable: _lazyCreateAttendanceTable,
  countCollectionsAndExtraQuorum: countCollectionsAndExtraQuorum,
  pgetMembersPivotDump: pgetMembersPivotDump,
  pgetEligibleMembersIds: pgetEligibleMembersIds,
  pgetMembersCollectionDump: pgetMembersCollectionDump
};

const pivotcols = 'newmemberid, famname, firstname, middlename, preferredname, birthdate, nric, mbrstatus, gender, maritalstatus, ' +
  'country, postalcode, yearjoin, prevchurch, ministry, serviceampm, nationality, marriagedate, placeofmarriage, '+
  'baptismdate, baptismchurch, confirmdate, confirmationchurch';

/**
 * @return an array of the members 'interesting' columns for a pivot.
 */
function pgetMembersPivotDump() {
  return _pgetMembers("SELECT "+pivotcols+" FROM orpcexcel");
}

const collectionCols = [/*'orpcexcel.newmemberid', */ // columns from the orpcexcel table
            'famname', 'firstname', 'middlename',
            'preferredname', 'birthdate', 'nric', 'membertype', 'orpcexcel.mbrstatus',
            'proxyid', 'desk', 'timestamp' ]; // columns from the voting table
/**
 * @return an array of the members 'interesting' columns joined with the current collection status
 * Filter out the ineligible members who have not voted.
 */
function pgetMembersCollectionDump() {
  var query = "SELECT "+collectionCols.join(',')+" FROM orpcexcel LEFT JOIN " + tableName +
  // We need to filter the non eligible members unless tey have voted.
  // Need to improve our SQL skills to do that. in the mean time we do it in the software.
            " ON orpcexcel.newmemberid = " + tableName + ".newmemberid";
  return _pgetMembers(query,
          function mapAndFilter(row) {
            var membertype = row.membertype ? row.membertype.toLowerCase() : '';
            var mbrstatus = row.mbrstatus ? row.mbrstatus.toLowerCase() : '';
            var isEligible = mbrstatus && mbrstatus === 'active' &&
              membertype &&
              membertype.indexOf('out') === -1 &&
              membertype.indexOf('infant') === -1;
            if (!isEligible && !row.timestamp) {
              return; // no need to list the inactives who have not voted.
            }
            var vals = [];
            for (var k in row) {
              if (row.hasOwnProperty(k)) {
                vals.push(row[k]);
              }
            }
            if (row.timestamp) {
              vals.push(isEligible ? 'has_voted' : 'has_voted not_eligible'); // computed column.
            } else {
              vals.push('has_not_voted');
            }
            vals.push( isEligible); // computed column.
            return vals;
            // return row;
          });
}
/*
SELECT table1.column1, table2.column2...
FROM table1
LEFT JOIN table2
ON table1.common_field = table2.common_field;
*/



/**
 * @return an array of all the eligible members id
 */
function pgetEligibleMembersIds() {
  return _pgetMembers("SELECT newmemberid FROM orpcexcel WHERE" +
      " membertype NOT LIKE '%infant%'" +
      " AND membertype NOT LIKE '%transfer%out%'" +
      // " AND mbrstatus NOT LIKE '%deceased%'" +
      " AND mbrstatus = 'Active'"
      , function(r) { return r.newmemberid; });
}

/**
 * @param cols columns to return.
 * @param mapAndFilter: optional function to transform each row. filter a row out if null is returned.
 */
function _pgetMembers(select, mapAndFilter) {
  return new Promise(function(accept, reject) {
    pool.getConnection(function(err, connection) {
      if (err) { return reject(err); }
      connection.query(select, function(err, res) {
        connection.release();
        if (res && Array.isArray(res)) {
          if (typeof mapAndFilter === 'function') {
            var finalRes = [];
            res.forEach(function(r) {
              var nr = mapAndFilter(r);
              if (nr) { finalRes.push(nr); }
            });
            res = finalRes;
          }
          return accept(res);
        }
        reject(err || new Error('Unexpected result format'));
      });
    });
  });
}
