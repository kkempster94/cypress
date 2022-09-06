import { defineStore } from 'pinia'

export interface LoginConnectState {
  isLoginConnectOpen: boolean
  utmMedium?: string
}

export const useLoginConnectStore = defineStore({
  id: 'loginConnect',

  state (): LoginConnectState {
    return {
      isLoginConnectOpen: false,
      utmMedium: undefined,
    }
  },

  actions: {
    openLoginConnectModal ({ utmMedium }: { utmMedium: string }) {
      this.isLoginConnectOpen = true
      // TODO: type for all valid utm_medium values?
      this.utmMedium = utmMedium
    },
    closeLoginConnectModal () {
      this.isLoginConnectOpen = false
      this.utmMedium = undefined
    },
  },
})