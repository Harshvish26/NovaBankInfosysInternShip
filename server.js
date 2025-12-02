require('dotenv').config();
const express = require('express');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const bodyParser = require('body-parser');
const path = require('path');
const connectDB = require('./config/db');

const app = express();
const PORT = process.env.PORT || 3000;

// connect DB
connectDB(process.env.MONGO_URI);

// view engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// static files
app.use(express.static(path.join(__dirname, 'public')));

// body parser
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// session
app.use(session({
  secret: process.env.SESSION_SECRET || 'default_secret_change_it',
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: process.env.MONGO_URI })
}));

// expose session to views
app.use((req, res, next) => {
  res.locals.session = req.session;
  next();
});

// routes
app.use('/', require('./routes/auth'));
app.use('/user', require('./routes/user'));
app.use('/admin', require('./routes/admin'));

// home route
app.get('/', (req, res) => res.render('home'));

app.listen(PORT, () => {
  console.log(`Server started on http://localhost:${PORT}`);
});
