require('babel-register')
require('../utils/binHelper')

/* eslint-disable import/first, import/no-dynamic-require, react/no-danger */

import React from 'react'
import PropTypes from 'prop-types'
import { renderToString } from 'react-dom/server'
import Helmet from 'react-helmet'
import { ReportChunks } from 'react-universal-component'
import flushChunks from 'webpack-flush-chunks'
import path from 'path'
import fs from 'fs-extra'
import glob from 'glob'
//
import getConfig from './getConfig'
import { DefaultDocument } from './RootComponents'
import { poolAll } from '../utils/shared'

//

process.on('message', async payload => {
  const { config, routes, defaultOutputFileRate } = payload
  console.log(routes.length)
  await poolAll(
    routes.map(route => async () => {
      try {
        await exportRoute({
          ...payload,
          route,
        })
        process.send({ type: 'tick' })
      } catch (err) {
        process.send({ type: 'error', err })
        process.exit(1)
      }
    }),
    Number(config.outputFileRate) || defaultOutputFileRate
  )
  process.send({ type: 'done' })
})

async function exportRoute ({ configPath, route, siteData, clientStats }) {
  const { sharedPropsHashes, templateID, localProps, allProps, path: routePath } = route

  // Get the config again
  const config = getConfig(configPath)

  // Use the node version of the app created with webpack
  const Comp = require(glob.sync(path.resolve(config.paths.DIST, 'static.*.js'))[0]).default

  // Retrieve the document template
  const DocumentTemplate = config.Document || DefaultDocument

  // This routeInfo will be saved to disk, and included in the html
  // that is served for that route as well
  const routeInfo = {
    path: routePath,
    sharedPropsHashes,
    templateID,
    localProps,
  }

  const embeddedRouteInfo = {
    ...routeInfo,
    allProps,
    siteData,
  }

  // Inject allProps into static build
  class InitialPropsContext extends React.Component {
    static childContextTypes = {
      routeInfo: PropTypes.object,
      staticURL: PropTypes.string,
    }
    getChildContext () {
      return {
        routeInfo: embeddedRouteInfo,
        staticURL: route.path,
      }
    }
    render () {
      return this.props.children
    }
  }

  // Make a place to collect chunks, meta info and head tags
  const renderMeta = {}
  const chunkNames = []
  let head = {}
  let clientScripts = []
  let clientStyleSheets = []

  const CompWithContext = props => (
    <ReportChunks report={chunkName => chunkNames.push(chunkName)}>
      <InitialPropsContext>
        <Comp {...props} />
      </InitialPropsContext>
    </ReportChunks>
  )

  const renderToStringAndExtract = comp => {
    // Rend the app to string!
    const appHtml = renderToString(comp)
    const { scripts, stylesheets } = flushChunks(clientStats, {
      chunkNames,
    })

    clientScripts = scripts
    clientStyleSheets = stylesheets

    // Extract head calls using Helmet synchronously right after renderToString
    // to not introduce any race conditions in the meta data rendering
    const helmet = Helmet.renderStatic()
    head = {
      htmlProps: helmet.htmlAttributes.toComponent(),
      bodyProps: helmet.bodyAttributes.toComponent(),
      base: helmet.base.toComponent(),
      link: helmet.link.toComponent(),
      meta: helmet.meta.toComponent(),
      noscript: helmet.noscript.toComponent(),
      script: helmet.script.toComponent(),
      style: helmet.style.toComponent(),
      title: helmet.title.toComponent(),
    }

    return appHtml
  }

  // Allow extractions of meta via config.renderToString
  const appHtml = await config.renderToHtml(
    renderToStringAndExtract,
    CompWithContext,
    renderMeta,
    clientStats
  )

  // Instead of using the default components, we need to hard code meta
  // from react-helmet into the components
  const HtmlWithMeta = ({ children, ...rest }) => (
    <html lang="en" {...head.htmlProps} {...rest}>
      {children}
    </html>
  )
  const HeadWithMeta = ({ children, ...rest }) => {
    let showHelmetTitle = true
    const childrenArray = React.Children.toArray(children).filter(child => {
      if (child.type === 'title') {
        // Filter out the title of the Document in static.config.js
        // if there is a helmet title on this route
        const helmetTitleIsEmpty = head.title[0].props.children === ''
        if (!helmetTitleIsEmpty) {
          return false
        }
        showHelmetTitle = false
      }
      return true
    })

    return (
      <head {...rest}>
        {head.base}
        {showHelmetTitle && head.title}
        {head.meta}
        {clientScripts.map(script => (
          <link
            key={`clientScript_${script}`}
            rel="preload"
            as="script"
            href={`${config.publicPath}${script}`}
          />
        ))}
        {clientStyleSheets.map(styleSheet => (
          <link
            key={`clientStyleSheet_${styleSheet}`}
            rel="preload"
            as="style"
            href={`${config.publicPath}${styleSheet}`}
          />
        ))}
        {clientStyleSheets.map(styleSheet => (
          <link
            key={`clientStyleSheet_${styleSheet}`}
            rel="stylesheet"
            href={`${config.publicPath}${styleSheet}`}
          />
        ))}
        {head.link}
        {head.noscript}
        {head.script}
        {head.style}
        {childrenArray}
      </head>
    )
  }
  // Not only do we pass react-helmet attributes and the app.js here, but
  // we also need to  hard code site props and route props into the page to
  // prevent flashing when react mounts onto the HTML.
  const BodyWithMeta = ({ children, ...rest }) => (
    <body {...head.bodyProps} {...rest}>
      {children}
      <script
        type="text/javascript"
        dangerouslySetInnerHTML={{
          __html: `
          window.__routeInfo = ${JSON.stringify(embeddedRouteInfo).replace(
      /<(\/)?(script)/gi,
      '<"+"$1$2'
    )};`,
        }}
      />
      {clientScripts.map(script => (
        <script key={script} defer type="text/javascript" src={`${config.publicPath}${script}`} />
      ))}
    </body>
  )

  // Render the html for the page inside of the base document.
  let html = `<!DOCTYPE html>${renderToString(
    <DocumentTemplate
      Html={HtmlWithMeta}
      Head={HeadWithMeta}
      Body={BodyWithMeta}
      siteData={siteData}
      renderMeta={renderMeta}
    >
      <div id="root" dangerouslySetInnerHTML={{ __html: appHtml }} />
    </DocumentTemplate>
  )}`

  const routeInfoFileContent = JSON.stringify(routeInfo)

  // If the siteRoot is set and we're not in staging, prefix all absolute URL's
  // with the siteRoot
  if (!process.env.REACT_STATIC_STAGING && config.siteRoot) {
    html = html.replace(/(href=["'])\/([^/])/gm, `$1${config.siteRoot}/$2`)
  }

  // If the route is a 404 page, write it directly to 404.html, instead of
  // inside a directory.
  const htmlFilename = route.is404
    ? path.join(config.paths.DIST, '404.html')
    : path.join(config.paths.DIST, route.path, 'index.html')

  // Make the routeInfo sit right next to its companion html file
  const routeInfoFilename = path.join(config.paths.DIST, route.path, 'routeInfo.json')

  const res = await Promise.all([
    fs.outputFile(htmlFilename, html),
    fs.outputFile(routeInfoFilename, routeInfoFileContent),
  ])
  return res
}
