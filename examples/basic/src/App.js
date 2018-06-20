import React from 'react'
import { hot } from 'react-hot-loader'
import { Router, Link } from '@reach/router'
//

// Anything imported from the 'pages' directory is automatically code-split!
import Home from 'pages/Home'
import About from 'pages/About'
import Blog from 'pages/Blog'

// Import some basic css
import './app.css'

const App = () => (
  <div>
    <nav>
      <Link to="/">Home</Link>
      <Link to="/about">About</Link>
      <Link to="/blog">Blog</Link>
    </nav>
    <div className="content">
      <Router>
        <Home path="/" />
        <About path="/about" />
        <Blog path="/blog/*" />
      </Router>
    </div>
  </div>
)

export default hot(module)(App)
