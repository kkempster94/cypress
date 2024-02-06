import Debug from 'debug'
import pDefer from 'p-defer'
import type { BrowserPreRequest } from '../../types'
import type Protocol from 'devtools-protocol'

const debug = Debug('cypress:proxy:service-worker-manager')

type ServiceWorkerRegistration = {
  registrationId: string
  scopeURL: string
  activatedServiceWorker?: ServiceWorker
}

type ServiceWorker = {
  registrationId: string
  scriptURL: string
  initiatorOrigin?: string
  controlledURLs: Set<string>
}

type RegisterServiceWorkerOptions = {
  registrationId: string
  scopeURL: string
}

type UnregisterServiceWorkerOptions = {
  registrationId: string
}

type AddActivatedServiceWorkerOptions = {
  registrationId: string
  scriptURL: string
}

type AddInitiatorToServiceWorkerOptions = {
  scriptURL: string
  initiatorOrigin: string
}

/**
 * Manages service worker registrations and their controlled URLs.
 *
 * The basic lifecycle is as follows:
 *
 * 1. A service worker is registered via `registerServiceWorker`.
 * 2. The service worker is activated via `addActivatedServiceWorker`.
 *
 * At some point while 1 and 2 are happening:
 *
 * 3. We receive a message from the browser that a service worker has been initiated with the `addInitiatorToServiceWorker` method.
 *
 * At this point, when the manager tries to process a browser pre-request, it will check if the request is controlled by a service worker.
 * It determines it is controlled by a service worker if:
 *
 * 1. The document URL for the browser pre-request matches the initiator origin for the service worker.
 * 2. The request URL is within the scope of the service worker or the request URL's initiator is controlled by the service worker.
 */
export class ServiceWorkerManager {
  private serviceWorkerRegistrations: Map<string, ServiceWorkerRegistration> = new Map<string, ServiceWorkerRegistration>()
  private pendingInitiators: Map<string, string> = new Map<string, string>()
  private pendingPotentiallyControlledRequests: Map<string, pDefer.DeferredPromise<boolean>[]> = new Map<string, pDefer.DeferredPromise<boolean>[]>()
  private pendingServiceWorkerFetches: Map<string, boolean[]> = new Map<string, boolean[]>()

  /**
   * Goes through the list of service worker registrations and adds or removes them from the manager.
   */
  updateServiceWorkerRegistrations (data: Protocol.ServiceWorker.WorkerRegistrationUpdatedEvent) {
    data.registrations.forEach((registration) => {
      if (registration.isDeleted) {
        this.unregisterServiceWorker({ registrationId: registration.registrationId })
      } else {
        this.registerServiceWorker({ registrationId: registration.registrationId, scopeURL: registration.scopeURL })
      }
    })
  }

  /**
   * Goes through the list of service worker versions and adds any that are activated to the manager.
   */
  updateServiceWorkerVersions (data: Protocol.ServiceWorker.WorkerVersionUpdatedEvent) {
    data.versions.forEach((version) => {
      if (version.status === 'activated') {
        this.addActivatedServiceWorker({ registrationId: version.registrationId, scriptURL: version.scriptURL })
      }
    })
  }

  /**
   * Adds an initiator URL to a service worker. If the service worker has not yet been activated, the initiator URL is added to a pending list and will
   * be added to the service worker when it is activated.
   */
  addInitiatorToServiceWorker ({ scriptURL, initiatorOrigin }: AddInitiatorToServiceWorkerOptions) {
    let initiatorAdded = false

    for (const registration of this.serviceWorkerRegistrations.values()) {
      if (registration.activatedServiceWorker?.scriptURL === scriptURL) {
        registration.activatedServiceWorker.initiatorOrigin = initiatorOrigin

        initiatorAdded = true
        break
      }
    }

    if (!initiatorAdded) {
      this.pendingInitiators.set(scriptURL, initiatorOrigin)
    }
  }

  handleServiceWorkerFetch (event: { url: string, isControlled: boolean }) {
    const promises = this.pendingPotentiallyControlledRequests.get(event.url)

    if (promises) {
      debug('found pending controlled request promise: %o', event)

      const currentPromiseForUrl = promises.shift()

      currentPromiseForUrl?.resolve(event.isControlled)
    } else {
      const fetches = this.pendingServiceWorkerFetches.get(event.url)

      debug('no pending controlled request promise found, adding a pending service worker fetch: %o', event)

      if (fetches) {
        fetches.push(event.isControlled)
      } else {
        this.pendingServiceWorkerFetches.set(event.url, [event.isControlled])
      }
    }
  }

  /**
   * Processes a browser pre-request to determine if it is controlled by a service worker. If it is, the service worker's controlled URLs are updated with the given request URL.
   *
   * @param browserPreRequest The browser pre-request to process.
   * @returns `true` if the request is controlled by a service worker, `false` otherwise.
   */
  async processBrowserPreRequest (browserPreRequest: BrowserPreRequest) {
    if (browserPreRequest.initiator?.type === 'preload') {
      return false
    }

    let requestPotentiallyControlledByServiceWorker = false
    let activatedServiceWorker: ServiceWorker | undefined
    const paramlessURL = browserPreRequest.url.split('?')[0]

    this.serviceWorkerRegistrations.forEach((registration) => {
      activatedServiceWorker = registration.activatedServiceWorker
      const paramlessDocumentURL = browserPreRequest.documentURL.split('?')[0]

      // We are determining here if a request is controlled by a service worker. A request is controlled by a service worker if
      // we have an activated service worker, the request URL does not come from the service worker, and the request
      // originates from the same origin as the service worker or from a script that is also controlled by the service worker.
      if (!activatedServiceWorker ||
        activatedServiceWorker.scriptURL === paramlessDocumentURL ||
        !activatedServiceWorker.initiatorOrigin ||
        !paramlessDocumentURL.startsWith(activatedServiceWorker.initiatorOrigin)) {
        return
      }

      const paramlessInitiatorURL = browserPreRequest.initiator?.url?.split('?')[0]
      const paramlessCallStackURL = browserPreRequest.initiator?.stack?.callFrames[0]?.url?.split('?')[0]
      const urlIsControlled = paramlessURL.startsWith(registration.scopeURL)
      const initiatorUrlIsControlled = paramlessInitiatorURL && activatedServiceWorker.controlledURLs?.has(paramlessInitiatorURL)
      const topStackUrlIsControlled = paramlessCallStackURL && activatedServiceWorker.controlledURLs?.has(paramlessCallStackURL)

      if (urlIsControlled || initiatorUrlIsControlled || topStackUrlIsControlled) {
        requestPotentiallyControlledByServiceWorker = true
      } else {
        console.log('not controlled', paramlessURL, paramlessInitiatorURL, paramlessCallStackURL, registration.scopeURL)
      }
    })

    if (activatedServiceWorker && requestPotentiallyControlledByServiceWorker && await this.isURLControlledByServiceWorker(browserPreRequest.url)) {
      activatedServiceWorker.controlledURLs.add(paramlessURL)

      return true
    }

    return false
  }

  private isURLControlledByServiceWorker (url: string) {
    const fetches = this.pendingServiceWorkerFetches.get(url)

    if (fetches) {
      const isControlled = fetches.shift()

      debug('found pending service worker fetch: %o', { url, isControlled })

      if (fetches.length === 0) {
        this.pendingServiceWorkerFetches.delete(url)
      }

      return Promise.resolve(isControlled)
    }

    let promises = this.pendingPotentiallyControlledRequests.get(url)

    if (!promises) {
      promises = []
      this.pendingPotentiallyControlledRequests.set(url, promises)
    }

    const deferred = pDefer<boolean>()

    promises.push(deferred)
    debug('adding pending controlled request promise: %s', url)

    return deferred.promise
  }

  /**
   * Registers the given service worker with the given scope. Will not overwrite an existing registration.
   */
  private registerServiceWorker ({ registrationId, scopeURL }: RegisterServiceWorkerOptions) {
    // Only register service workers if they haven't already been registered
    if (this.serviceWorkerRegistrations.get(registrationId)?.scopeURL === scopeURL) {
      return
    }

    this.serviceWorkerRegistrations.set(registrationId, {
      registrationId,
      scopeURL,
    })
  }

  /**
   * Unregisters the service worker with the given registration ID.
   */
  private unregisterServiceWorker ({ registrationId }: UnregisterServiceWorkerOptions) {
    this.serviceWorkerRegistrations.delete(registrationId)
  }

  /**
   * Adds an activated service worker to the manager.
   */
  private addActivatedServiceWorker ({ registrationId, scriptURL }: AddActivatedServiceWorkerOptions) {
    const registration = this.serviceWorkerRegistrations.get(registrationId)

    if (registration) {
      const initiatorOrigin = this.pendingInitiators.get(scriptURL)

      registration.activatedServiceWorker = {
        registrationId,
        scriptURL,
        controlledURLs: registration.activatedServiceWorker?.controlledURLs || new Set<string>(),
        initiatorOrigin: initiatorOrigin || registration.activatedServiceWorker?.initiatorOrigin,
      }

      this.pendingInitiators.delete(scriptURL)
    } else {
      debug('Could not find service worker registration for registration ID %s', registrationId)
    }
  }
}
