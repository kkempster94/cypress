import { debug as debugFn } from 'debug'
import { AddressInfo } from 'net'
import { Server } from 'http'
import _ from 'lodash'
import WebpackDevServer from 'webpack-dev-server'
import { start as createDevServer, StartDevServer, WebpackConfigurationWithDevServer } from './startServer'
import { webpackDevServerFacts } from './webpackDevServerFacts'

const debug = debugFn('cypress:webpack-dev-server:webpack')

type DoneCallback = () => unknown

export interface ResolvedDevServerConfig {
  port: number
  close: (done?: DoneCallback) => void
}

export { StartDevServer }

export async function startDevServer (startDevServerArgs: StartDevServer, exitProcess = process.exit) {
  const webpackDevServer = await createDevServer(startDevServerArgs, exitProcess)

  return new Promise<ResolvedDevServerConfig>(async (resolve, reject) => {
    if (webpackDevServerFacts.isV3()) {
      // @ts-ignore
      const server: Server = webpackDevServer.listen(0, '127.0.0.1', () => {
        // FIXME: handle address returning a string
        const port = (server.address() as AddressInfo).port

        debug('Component testing webpack server started on port', port)

        resolve({
          port,
          close: (done?: DoneCallback) => {
            server.close()
            done?.()
          },
        })
      })

      return
    }

    if (webpackDevServerFacts.isV4()) {
      await webpackDevServer.start()

      // We need to put our middleware - to trigger webpack to recompile when an inactive spec is requested -
      // at the top of the express app's routing stack. There's no official way to do this, therefore we use a dirty hack.
      webpackDevServer.app?.get('*', recompileMiddleware(webpackDevServer, startDevServerArgs.options))
      const [ourMiddleware] = webpackDevServer.app?._router.stack.splice(-1, 1)
      webpackDevServer.app?._router.stack.splice(2, 0, ourMiddleware)

      resolve({
        // @ts-expect-error @types do not yet support v4
        port: webpackDevServer.options.port,
        close: (done?: DoneCallback) => {
          webpackDevServer.stop()
          done?.()
        },
      })

      return
    }

    reject(webpackDevServerFacts.unsupported())
  })
}

function recompileMiddleware(webpackDevServer: WebpackDevServer, options: any) {
  return (req: any, res: any, next: any) => {
    console.log('incoming request', req.url, req.get('referer'))
    if (req.url === "/__cypress/src/runtime-main.js") {
      const spec = _.last(req.get('referer').split('/__cypress/iframes/'))
      console.log(spec)
      options.devServerEvents.emit('webpack-dev-server:request', spec)
    }

    next()
  }
}

export interface CypressWebpackDevServerConfig{
  /* support passing a path to the user's webpack config */
  webpackConfig?: WebpackConfigurationWithDevServer
  /* base html template to render in AUT */
  template?: string
}

export function devServer (cypressDevServerConfig: Cypress.DevServerConfig, devServerConfig?: CypressWebpackDevServerConfig) {
  return startDevServer({
    options: cypressDevServerConfig,
    webpackConfig: devServerConfig?.webpackConfig,
    template: devServerConfig?.template,
  })
}
