const { getCtx, hasCtx } = require('@packages/data-context')

const registerEvent = (event, callback) => {
  getCtx().lifecycleManager.registerEvent(event, callback)
}

const getPluginPid = () => {
  return getCtx().lifecycleManager.eventProcessPid
}

let handlers = []

const registerHandler = (handler) => {
  handlers.push(handler)
}

const getHandlers = () => {
  return handlers
}

const init = (config, options) => {
  return getCtx().lifecycleManager.initPlugins()
}

const has = (event) => {
  return getCtx().lifecycleManager.hasNodeEvent(event)
}

const execute = (event, ...args) => {
  return getCtx().lifecycleManager.executeNodeEvent(event, args)
}

const _reset = () => {
  handlers = []
  getCtx().lifecycleManager.resetForTest()
}

module.exports = {
  getPluginPid,
  execute,
  has,
  init,
  registerEvent,
  registerHandler,
  getHandlers,

  // for testing purposes
  _reset,
}
