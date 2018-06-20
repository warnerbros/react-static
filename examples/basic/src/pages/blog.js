import React from 'react'
import { Router, Link } from '@reach/router'
import { RouteData } from 'react-static'
//

// Anything imported from 'templates' is automatically code-split
import Post from 'templates/Post'

export default () => (
  <Router>
    <RouteData path="/">
      {({ posts }) => (
        <div>
          <h1>It's blog time.</h1>
          <br />
          All Posts:
          <ul>
            {posts.map(post => (
              <li key={post.id}>
                <Link to={`post/${post.id}/`}>{post.title}</Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </RouteData>
    <Post path="post/:id" />
  </Router>
)
