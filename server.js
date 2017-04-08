const cluster = require('cluster');
const express = require('express');
const path = require('path');
const logger = require('morgan');
const session = require('express-session');
const RedisStore = require('connect-redis')(session);
const redis = require('socket.io-redis');
const bodyParser = require('body-parser');
const helmet = require('helmet');
const passport = require('passport');
const bluebird = require('bluebird');
const AWS = require('aws-sdk');
const http = require('http');
const mongoose = require('mongoose');

if(cluster.isMaster) {
  cluster.fork();
  cluster.on('exit', (worker, code, signal) => {
    if(signal) {
      console.log(`Workder ${worker.id} killed by signal: ${signal}`);
    } else {
      console.log(`Worker ${worker.id} exited with error code: ${code}`);
    }
    cluster.fork();
  });
} else {
  const app = express();

  // configure AWS
  AWS.config.update({ region: 'us-east-1' });
  // TODO: bucket name
  const S3 = new AWS.S3({
    apiVersion: '2006-03-01',
    sslEnabled: true,
    params: { Bucket: '' }
  });

  // get port, production params
  const argv = require('minimist')(process.argv.slice(2));
  const PORT = Number(argv.p) || Number(argv.port) || 5000;
  const PRODUCTION = Boolean(argv.production);
  app.set('port', PORT);

  if(!PRODUCTION) {
    app.use(logger('dev'));
  }

  // configure mongoose
  mongoose.Promise = bluebird;
  // TODO: add connection
  mongoose.createConnection('');

  // configure security
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet.xssFilter());
  app.use(helmet.frameguard('sameorigin'));

  // view engine
  app.set('views', './views');
  app.set('view engine', 'pug');
  app.set('view cache', false);

  app.use(bodyParser.json());
  app.use(bodyParser.urlencoded({ extended: false }));
  app.use(express.static(path.join(__dirname, 'www')));
  app.use(passport.initialize());

  // CORS
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Credentials', true);
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, X-HTTP-Method-Override, Content-Type, Accept, x-access-token');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    next();
  });

  // configure sessions
  // TODO: session secret, session name
  const sessionSettings = {
    secret: '',
    name: '',
    cookie: {
      maxAge: 7 * 24 * 3600 * 1000,
      httpOnly: true
    },
    resave: false,
    saveUninitialized: false,
    store: new RedisStore({ port: 6379 })
  };
  const sessionMiddleware = session(sessionSettings);
  app.use(sessionMiddleware);

  // server
  const server = http.createServer(app);
  server.listen(PORT);
  server.on('error', (err) => {
    if(err.syscall !== 'listen') {
      throw err;
    }

    const bind = typeof PORT === 'string' ? `Pipe ${PORT}` : `Port ${PORT}`;

    switch (err.code) {
    case 'EACCES':
      console.error(`${bind} requires elevated privileges`);
      process.exit(1);
      break;
    case 'EADDRINUSE':
      console.error(`${bind} is already in use`);
      process.exit(1);
      break;
    default:
      throw err;
    }
  });
  server.on('listening', () => {
    console.log(`Server listening on port ${PORT}`);
  });

  // configure socket.io
  const io = require('socket.io')(server, {
    transports: [
      'websocket',
      'flashsocket',
      'htmlfile',
      'xhr-polling',
      'jsonp-polling',
      'polling'
    ]
  });
  io.use((socket, next) => {
    sessionMiddleware(socket.request, {}, next);
  });
  io.adapter(redis({
    host: 'localhost',
    port: 6379
  }));
  
  process.on('uncaughtException', (err) => {
    console.log(`uncaughtException: ${err}\n${err.stack}`);
    process.exit(1);
  });

  // TODO: routes

  app.use((req, res, next) => {
    const err = new Error('Not Found');
    err.status = 404;
    next(err);
  });

  app.use((err, req, res, next) => {
    res.status(err.status || 500);
    res.render('error', {
      message: err.message
    });
  });
}