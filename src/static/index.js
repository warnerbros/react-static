import fs from 'fs-extra'
import path from 'path'
import shorthash from 'shorthash'
import chalk from 'chalk'
import Progress from 'progress'
import OS from 'os'
import { fork } from 'child_process'
//
import generateRoutes from './generateRoutes'
import { poolAll, pathJoin } from '../utils/shared'

//

const defaultOutputFileRate = 100

const cores = Math.max(OS.cpus().length, 1)

const Bar = (len, label) =>
  new Progress(`=> ${label ? `${label} ` : ''}[:bar] :current/:total :percent :rate/s :etas `, {
    total: len,
  })

export const prepareRoutes = async (config, opts) => {
  config.routes = await config.getRoutes(opts)

  process.env.REACT_STATIC_ROUTES_PATH = path.join(config.paths.DIST, 'react-static-routes.js')

  // Dedupe all templates into an array
  const templates = []

  config.routes.forEach(route => {
    if (!route.component) {
      return
    }
    // Check if the template has already been added
    const index = templates.indexOf(route.component)
    if (index === -1) {
      // If it's new, add it
      templates.push(route.component)
      // Assign the templateID
      route.templateID = templates.length - 1
    } else {
      // Assign the existing templateID
      route.templateID = index
    }
  })

  config.templates = templates

  return generateRoutes({
    config,
  })
}

// Exporting route HTML and JSON happens here. It's a big one.
export const exportRoutes = async ({ configPath, config, clientStats }) => {
  console.log('=> Fetching Site Data...')
  console.time(chalk.green('=> [\u2713] Site Data Downloaded'))
  // Get the site data
  const siteData = await config.getSiteData({ dev: false })
  console.timeEnd(chalk.green('=> [\u2713] Site Data Downloaded'))

  // Set up some scaffolding for automatic data splitting
  const seenProps = new Map()
  const sharedProps = new Map()

  console.log('=> Fetching Route Data...')
  const dataProgress = Bar(config.routes.length)
  console.time(chalk.green('=> [\u2713] Route Data Downloaded'))

  await poolAll(
    config.routes.map(route => async () => {
      // Fetch allProps from each route
      route.allProps = !!route.getData && (await route.getData({ route, dev: false }))

      // Default allProps (must be an object)
      if (!route.allProps) {
        route.allProps = {}
      }

      // TODO: check if route.allProps is indeed an object

      // Loop through the props to find shared props between routes
      // TODO: expose knobs to tweak these settings, perform them manually,
      // or simply just turn them off.
      Object.keys(route.allProps)
        .map(k => route.allProps[k])
        .forEach(prop => {
          // Don't split small strings
          if (typeof prop === 'string' && prop.length < 100) {
            return
          }
          // Don't split booleans or undefineds
          if (['boolean', 'number', 'undefined'].includes(typeof prop)) {
            return
          }
          // Should be an array or object at this point
          // Have we seen this prop before?
          if (seenProps.get(prop)) {
            // Only cache each shared prop once
            if (sharedProps.get(prop)) {
              return
            }
            // Cache the prop
            const jsonString = JSON.stringify(prop)
            sharedProps.set(prop, {
              jsonString,
              hash: shorthash.unique(jsonString),
            })
          } else {
            // Mark the prop as seen
            seenProps.set(prop, true)
          }
        })
      dataProgress.tick()
    }),
    Number(config.outputFileRate) || defaultOutputFileRate
  )

  console.timeEnd(chalk.green('=> [\u2713] Route Data Downloaded'))

  console.log('=> Exporting Route Data...')
  console.time(chalk.green('=> [\u2713] Route Data Exported'))
  await poolAll(
    config.routes.map(route => async () => {
      // Loop through the props and build the prop maps
      route.localProps = {}
      route.sharedPropsHashes = {}
      Object.keys(route.allProps).forEach(key => {
        const value = route.allProps[key]
        const cached = sharedProps.get(value)
        if (cached) {
          route.sharedPropsHashes[key] = cached.hash
        } else {
          route.localProps[key] = value
        }
      })
    }),
    Number(config.outputFileRate) || defaultOutputFileRate
  )
  console.timeEnd(chalk.green('=> [\u2713] Route Data Exported'))

  // Write all shared props to file
  const sharedPropsArr = Array.from(sharedProps)

  if (sharedPropsArr.length) {
    console.log('=> Exporting Shared Route Data...')
    const jsonProgress = Bar(sharedPropsArr.length)
    console.time(chalk.green('=> [\u2713] Shared Route Data Exported'))

    await poolAll(
      sharedPropsArr.map(cachedProp => async () => {
        await fs.outputFile(
          path.join(config.paths.STATIC_DATA, `${cachedProp[1].hash}.json`),
          cachedProp[1].jsonString || '{}'
        )
        jsonProgress.tick()
      }),
      Number(config.outputFileRate) || defaultOutputFileRate
    )
    console.timeEnd(chalk.green('=> [\u2713] Shared Route Data Exported'))
  }

  console.log('=> Exporting HTML...')
  const htmlProgress = Bar(config.routes.length)
  console.time(chalk.green('=> [\u2713] HTML Exported'))

  const tasksPerExporter = Math.floor(config.routes.length / cores)
  const exporters = []
  for (let i = 0; i < cores; i++) {
    exporters.push(
      fork(require.resolve('./exportRoute'), [], {
        env: process.env,
      })
    )
  }

  let cursor = 0
  await Promise.all(
    exporters.map((exporter, i) => {
      const nextCursor = cursor + tasksPerExporter
      const routes = config.routes.slice(
        cursor,
        i - 1 < exporters.length ? nextCursor : config.routes.length
      )
      cursor = nextCursor
      return new Promise((resolve, reject) => {
        exporter.send({
          configPath,
          config,
          routes,
          siteData,
          clientStats,
          defaultOutputFileRate,
        })
        exporter.on('message', ({ type, err }) => {
          if (err) {
            reject(err)
          }
          if (type === 'tick') {
            htmlProgress.tick()
          }
          if (type === 'done') {
            resolve()
          }
        })
      })
    })
  )
  console.timeEnd(chalk.green('=> [\u2713] HTML Exported'))
}

export async function buildXMLandRSS ({ config }) {
  if (!config.siteRoot) {
    return
  }
  const xml = generateXML({
    routes: config.routes.filter(d => !d.is404).map(route => ({
      permalink: `${config.publicPath}${pathJoin(route.path)}`,
      lastModified: '',
      priority: 0.5,
      ...route,
    })),
  })

  await fs.writeFile(path.join(config.paths.DIST, 'sitemap.xml'), xml)

  function generateXML ({ routes }) {
    let xml =
      '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
    routes.forEach(route => {
      if (route.noindex) {
        return
      }
      xml += '<url>'
      xml += `<loc>${`${route.permalink}/`.replace(/\/{1,}$/gm, '/')}</loc>`
      xml += route.lastModified ? `<lastmod>${route.lastModified}</lastmod>` : ''
      xml += route.priority ? `<priority>${route.priority}</priority>` : ''
      xml += '</url>'
    })
    xml += '</urlset>'
    return xml
  }
}
