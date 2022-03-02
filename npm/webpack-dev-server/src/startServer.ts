import Debug from 'debug'
import webpack from 'webpack'
import * as path from 'path'
import WebpackDevServer from 'webpack-dev-server'
import { makeWebpackConfig, UserWebpackDevServerOptions } from './makeWebpackConfig'
import { webpackDevServerFacts } from './webpackDevServerFacts'

export interface StartDevServer extends UserWebpackDevServerOptions {
  /* this is the Cypress dev server configuration object */
  options: Cypress.DevServerConfig
  /* Base webpack config object used for loading component testing */
  webpackConfig?: WebpackConfigurationWithDevServer
  /* base html template to render in AUT */
  template?: string
  /* base html template to render in AUT */
  indexHtml?: string

}

export interface WebpackConfigurationWithDevServer extends webpack.Configuration {
  devServer?: WebpackDevServer.Configuration
}

const OsSeparatorRE = RegExp(`\\${path.sep}`, 'g')
const posixSeparator = '/'

const debug = Debug('cypress:webpack-dev-server:start')

export async function start ({ webpackConfig: userWebpackConfig, indexHtml, options, ...userOptions }: StartDevServer, exitProcess = process.exit): Promise<WebpackDevServer> {
  if (!userWebpackConfig) {
    debug('User did not pass in any webpack configuration')
  }

  const { projectRoot, devServerPublicPathRoute, isTextTerminal } = options.config

  const publicPath = (path.sep === posixSeparator)
    ? path.join(devServerPublicPathRoute, posixSeparator)
    // The second line here replaces backslashes on windows with posix compatible slash
    // See https://github.com/cypress-io/cypress/issues/16097
    : path.join(devServerPublicPathRoute, posixSeparator)
    .replace(OsSeparatorRE, posixSeparator)

  const webpackConfig = await makeWebpackConfig(userWebpackConfig || {}, {
    files: options.specs,
    indexHtml,
    projectRoot,
    devServerPublicPathRoute,
    publicPath,
    devServerEvents: options.devServerEvents,
    supportFile: options.config.supportFile as string,
    isOpenMode: !isTextTerminal,
    ...userOptions,
  })

  debug('compiling webpack')

  const compiler = webpack(webpackConfig)

  // When compiling in run mode
  // Stop the clock early, no need to run all the tests on a failed build
  if (isTextTerminal) {
    compiler.hooks.done.tap('cyCustomErrorBuild', function (stats) {
      if (stats.hasErrors()) {
        exitProcess(1)
      }
    })
  }

  debug('starting webpack dev server')
  let webpackDevServerConfig: WebpackDevServer.Configuration = {
    ...(userWebpackConfig?.devServer || {}),
    hot: false,
  }

  if (webpackDevServerFacts.isV3()) {
    debug('using webpack-dev-server v3')
    webpackDevServerConfig = {
      ...webpackDevServerConfig,
      // @ts-ignore ignore webpack-dev-server v3 type errors
      inline: false,
      publicPath: devServerPublicPathRoute,
      noInfo: false,
    }

    // @ts-ignore ignore webpack-dev-server v3 type errors
    return new WebpackDevServer(compiler, webpackDevServerConfig)
  }

  if (webpackDevServerFacts.isV4()) {
    debug('using webpack-dev-server v4')
    webpackDevServerConfig = {
      host: 'localhost',
      port: 'auto',
      ...userWebpackConfig?.devServer,
      devMiddleware: {
        publicPath: devServerPublicPathRoute,
      },
      hot: false,
    }

    // @ts-ignore Webpack types are clashing between Webpack and WebpackDevServer
    const server = new WebpackDevServer(webpackDevServerConfig, compiler)
    return server
  }

  throw webpackDevServerFacts.unsupported()
}
