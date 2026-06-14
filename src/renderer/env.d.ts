import type { ModbusApi } from '../shared/types'

declare global {
  interface Window {
    modbusApi: ModbusApi
  }
}

export {}
