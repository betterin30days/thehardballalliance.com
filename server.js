'use strict';

let express = require("express");
let bodyParser = require("body-parser");
let { Client, Pool } = require("pg");
const crypto = require("crypto");

// load .env if not in prod
let SSL = true; // user SSL in prod, not on local host
if (process.env.NODE_ENV !== "production") {
    require("dotenv").load();
    SSL = false;
}

// configure express app
let app = express();
app.use(bodyParser.json());

// set where static angular generated dist files are stored
let distDir = __dirname + "/dist/";
app.use(express.static(distDir));

// start app
let server = app.listen(process.env.PORT || 8080, function () {
    let port = server.address().port;
    console.log("App now running on port ", port);
});

// connection pool for postgreSQL DB connections
const POOL = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: SSL // heroku PG requries ssl
});

function generatePasswordHash(secret, salt) {
    const hash = crypto.pbkdf2Sync(secret, salt, 100000, 64, 'sha256');
    return hash.toString('hex');
}

async function userIsAuthorized(auth) {
    // query DB to confirm that this username and token are valid
    // auth is a string of username:token
    const split = auth.split(':');
    const user = split[0];
    const token = split[1];
    // query DB
    const text = 'SELECT id FROM hardball.auth WHERE username=$1 AND token=$2;';
    const values = [user, token];
    const { rows } = await POOL.query(text, values);
    return rows.length === 1; // bool of is user was found in DB
}

// Generic error handler
function handleError(res, reason, message, code) {
    console.log("Error: " + reason);
    res.status(code || 500).json({"error": message});
}

// get all posts
app.get("/api/posts", function(req, res) {
    // can receive a start and end timestamp in query string
    // ?start=0000&stop=0000
    // values are ms timestamp of range to get posts from
    // if range isn't supplied, get all posts from the DB
    // return an array of post objects

    // postgreSQL is using bigint data type to store ms timestamp
    // js number data type is a bit more restricted
    // psql limit: +/-9223372036854775808
    // js limit:   +/-   9007199254740991
    // the JS limit represents the earliest and latest possible time
    // which covers well over the uses case
    // this gives us ~285k years before and after epoch!
    const start = req.query.start ? req.query.start : -9007199254740991;
    const end = req.query.end ? req.query.end : 9007199254740991;
    const text = `
        SELECT id, title, body, publish_date
        FROM hardball.posts
        WHERE publish_date BETWEEN $1 AND $2
        ORDER BY publish_date DESC;
    `
    const values = [start, end];
    POOL.query(text, values, (err, result) => {
        if (err) throw err;
        const posts = [];
        for (let row of result.rows) {
            posts.push(row);
        }
        res.status(200).json({posts: posts})
    });
})

// create a news feed post
app.post("/api/posts/create", function(req, res) {
    // receives a Post object
    // {title: string, body: string, publishDate: int, createDate: int}
    // add this to the DB
    (async () => {
        if ('authorization' in req.headers && await userIsAuthorized(req.headers['authorization'])) {
            let newPost = req.body;
            if (
                newPost.hasOwnProperty("title") &&
                newPost.hasOwnProperty("body") &&
                newPost.hasOwnProperty("publishDate") &&
                newPost.hasOwnProperty("createDate")
            ) {
                // data is valid
                // INSERT into DB
                const text = 'INSERT INTO hardball.posts (title, body, publish_date, create_date) VALUES ($1, $2, $3, $4);'
                const values = [newPost.title, newPost.body, newPost.publishDate, newPost.createDate];
                await POOL.query(text, values);
                res.status(201).json({status: 201, post: newPost});
            } else {
                // data is not valid
                res.status(400).json({status: 400, error: 'Data is invalid'});
            }
        } else {
            res.status(401).json({error: 'Unauthorized!'});
        }
    })().catch(e => {
        console.error(e.stack);
        res.status(500).json({error: 'An unexpected error occured!'});
    });
});

// modify an exisiting post
app.put("/api/posts/modify/:postId", function(req, res) {
    // receives a Post object
    // {title: string, body: string, id:int, publishDate: int, createDate: int}
    // modify the post in DB at the provided id
    (async () => {
        if ('authorization' in req.headers && await userIsAuthorized(req.headers['authorization'])) {
            let post = req.body;
            let id = req.params.postId;
            if (
                post.hasOwnProperty("title") &&
                post.hasOwnProperty("body") &&
                post.hasOwnProperty("publishDate")
                // create date is never changed
            ) {
                // data is valid
                // UPDATE in DB
                const text = `
                    UPDATE hardball.posts
                    SET title = $1, body = $2, publish_date = $3
                    WHERE id = $4;
                `;
                const values = [post.title, post.body, post.publishDate, id];
                await POOL.query(text, values);
                res.status(200).json({status: 200, post: post});
            } else {
                // data is not valid
                res.status(400).json({status: 400, error: 'Data is invalid'});
            }
        } else {
            res.status(401).json({error: 'Unauthorized!'});
        }
    })().catch(e => {
        console.error(e.stack);
        res.status(500).json({error: 'An unexpected error occured!'});
    });
});

// delete an exisiting post
app.delete("/api/posts/delete/:postId", function(req, res) {
    // receives the ID of the post to delete
    (async () => {
        if ('authorization' in req.headers && await userIsAuthorized(req.headers['authorization'])) {
            let id = req.params.postId;
            // DELETE row from DB
            const text = `
                DELETE FROM hardball.posts
                WHERE id = $1;
            `;
            const values = [id];
            await POOL.query(text, values);
            res.status(200).json({status: 200, post: id});
        } else {
            res.status(401).json({error: 'Unauthorized!'});
        }
    })().catch(e => {
        console.error(e.stack);
        res.status(500).json({error: 'An unexpected error occured!'});
    });
});

// authorize a user
app.post("/api/auth/login", function(req, res) {
    // receives a username and password object
    // {username: string, password: string}
    // confirm auth with the DB
    const user = req.body;
    const name = user['username'];
    const pass = user['password'];
    const text = 'SELECT salt, token, pass_hash FROM hardball.auth WHERE username = $1;'
    const values = [name];
    POOL.query(text, values, (err, result) => {
        if (err) throw err;
        // should only return 1
        if (result.rows.length === 1) {
            const salt = result.rows[0]['salt'];
            const pass_hash = result.rows[0]['pass_hash'];
            // check if password hashes match
            if (generatePasswordHash(pass, salt) === pass_hash) {
                // password is correct
                const token = result.rows[0]['token'];
                res.status(200).json({'user': name, 'status': 200, 'token': token});
            } else {
                // password is incorrect
                res.status(401).json({'user': name, 'status': 401, 'error': 'Either the username or password is incorrect'});
            }
        } else {
            // username not found
            res.status(401).json({'user': name, 'status': 401, 'error': 'Either the username or password is incorrect'});
        }
    });
});

// create a new user
app.post("/api/auth/register", function(req, res) {
    // receives a username and password object
    // {username: string, password: string}
    // confirm that the username is whitelisted to register
    // adds the user to the DB
    const user = req.body;
    const name = user['username'];
    const pass = user['password'];
    // create a multiple transaction connection
    POOL.connect((err, client, done) => {
        const shouldAbort = (err) => {
            // cleanup function if there is an error
            if (err) {
                console.error('Error in transaction', err.stack)
                client.query('ROLLBACK', (err) => {
                    if (err) {
                        console.error('Error rolling back client', err.stack)
                    }
                    // release the client back to the pool
                    done();
                });
            }
            return !!err // cast to bool
        }

        // BEGIN the transaction
        client.query('BEGIN', (err) => {
            if (shouldAbort(err)) return;
            // first query if this username is in the DB
            // return username and token
            const selectText = 'SELECT id, username, token FROM hardball.auth WHERE username = $1;'
            const selectValues = [name];
            client.query(selectText, selectValues, (err, result) => {
                if (shouldAbort(err)) return;
                // username is a unique value, can only return 1 row
                if (result.rows.length) {
                    // username was found
                    if (!result.rows[0]['token']) {
                        // token is empty
                        // user is allowed to register
                        const rowId = result.rows[0]['id'];
                        const token = crypto.randomBytes(32).toString('hex');
                        const salt = crypto.randomBytes(32).toString('hex');
                        const passHash = generatePasswordHash(pass, salt);
                        // UPDATE the row
                        const updateText = 'UPDATE hardball.auth SET salt = $1, token = $2, pass_hash = $3 WHERE id = $4;';
                        const updateValues = [salt, token, passHash, rowId];
                        client.query(updateText, updateValues, (err, result) => {
                            if (shouldAbort(err)) return;
                            // succesfully updates
                            // COMMIT the changes
                            client.query('COMMIT', (err) => {
                                if (err) {
                                    console.error('Error committing transaction!', err.stack);
                                }
                                done();
                                res.status(201).json({'user': name, 'status': 201,});
                            })
                        });
                    } else {
                        // token found
                        // user is already registered
                        done();
                        res.status(409).json({'status': 409, 'error': 'User is already registered!'}); // 409 Conflict
                    }
                } else {
                    // username was not found
                    done();
                    res.status(403).json({'status': 403, 'error': 'This user is not allowed to register!'}); // 403 Forbidden
                }
            });
        });
    });
});

// catch all other get requests to be sent index.html
// this allows the angular router to handle paths
app.get("/*", function(req, res) {
    res.sendFile(distDir + '/index.html')
});
