import type { RegisterDefinition, ServerAreaName } from '../../shared/types'

/**
 * @brief 将数值地址格式化为十六进制显示文本。
 * @param address 数值地址。
 * @returns 带 0x 前缀的四位大写十六进制字符串。
 */
export function formatAddressHex(address: number): string {
  return `0x${address.toString(16).toUpperCase().padStart(4, '0')}`
}

/**
 * @brief 解析十六进制地址字符串为数值。
 *
 * 支持 0x 前缀和纯十六进制，也兼容十进制数字。
 * @param text 地址文本。
 * @returns 解析后的数值，无效时返回 NaN。
 */
export function parseHexAddress(text: string): number {
  const trimmed = text.trim()
  if (/^0x[0-9a-fA-F]+$/.test(trimmed)) return Number.parseInt(trimmed.slice(2), 16)
  if (/^[0-9a-fA-F]+$/.test(trimmed)) return Number.parseInt(trimmed, 16)
  return Number(trimmed)
}

export interface RegisterAddressInfo {
  area: ServerAreaName
  protocolAddress: number
}

/**
 * @brief 数据类型到默认寄存器长度的映射。
 *
 * 单寄存器类型长度为 1，双寄存器类型（32 位整型、浮点、BCD）长度为 2。
 */
export const DATA_TYPE_DEFAULT_LENGTHS: Record<string, number> = {
  UINT16: 1, INT16: 1, BIT: 1,
  UINT32: 2, INT32: 2, BCD: 2,
  FLOAT_ABCD: 2, FLOAT_CDAB: 2, FLOAT_BADC: 2, FLOAT_DCBA: 2
}

/**
 * @brief 获取数据类型的默认寄存器长度。
 *
 * 未识别的数据类型默认返回 1，避免意外赋值。
 * @param dataType 数据类型字符串。
 * @returns 默认寄存器个数。
 */
export function getDefaultLengthForType(dataType: string): number {
  return DATA_TYPE_DEFAULT_LENGTHS[dataType] ?? 1
}

/**
 * @brief 解析字典显示地址所属的 Modbus 数据区。
 *
 * 将 0xxxx、1xxxx、3xxxx、4xxxx 显示地址转换为 Server 使用的数据区名称和零基协议地址。
 * @param address 字典中的显示地址。
 * @returns 地址有效时返回数据区信息，否则返回 null。
 */
export function resolveRegisterAddress(address: number): RegisterAddressInfo | null {
  if (address >= 1 && address <= 9999) return { area: 'coil', protocolAddress: address - 1 }
  if (address >= 10001 && address <= 19999) return { area: 'discrete', protocolAddress: address - 10001 }
  if (address >= 30001 && address <= 39999) return { area: 'input', protocolAddress: address - 30001 }
  if (address >= 40001 && address <= 49999) return { area: 'holding', protocolAddress: address - 40001 }
  return null
}

/**
 * @brief 格式化寄存器原始十六进制值。
 *
 * 每个寄存器固定显示四位大写十六进制，多个寄存器使用空格分隔。
 * @param values 16 位寄存器数组。
 * @returns 格式化文本，无数据时返回短横线。
 */
export function formatRegisterHex(values: number[]): string {
  return values.length > 0 ? values.map((value) => (value & 0xffff).toString(16).padStart(4, '0').toUpperCase()).join(' ') : '-'
}

/**
 * @brief 按字典数据类型解析寄存器值。
 *
 * 支持无符号、有符号、四种浮点字节序、BCD 和 BIT，并在数值解析后应用比例因子。
 * @param item 寄存器字典条目。
 * @param values 原始 16 位寄存器数组。
 * @returns 解析后的显示文本，无数据时返回短横线。
 */
export function decodeRegisterValue(item: RegisterDefinition, values: number[]): string {
  if (values.length === 0) return '-'
  const factor = Number.isFinite(item.factor) ? item.factor : 1
  let value: number
  switch (item.dataType) {
    case 'INT16':
      value = values[0] > 0x7fff ? values[0] - 0x10000 : values[0]
      break
    case 'UINT32':
      value = ((values[0] & 0xffff) * 0x10000) + (values[1] ?? 0)
      break
    case 'INT32': {
      const unsigned = ((values[0] & 0xffff) * 0x10000) + (values[1] ?? 0)
      value = unsigned > 0x7fffffff ? unsigned - 0x100000000 : unsigned
      break
    }
    case 'FLOAT_ABCD':
    case 'FLOAT_CDAB':
    case 'FLOAT_BADC':
    case 'FLOAT_DCBA':
      value = decodeFloat(item.dataType, values)
      break
    case 'BCD':
      value = Number(formatRegisterHex(values).replace(/ /g, ''))
      break
    case 'BIT':
      value = values[0] ? 1 : 0
      break
    default:
      value = values[0] & 0xffff
  }
  const scaled = value * factor
  return Number.isFinite(scaled) ? String(Number(scaled.toPrecision(12))) : '-'
}

/**
 * @brief 将解析值编码为寄存器数组。
 *
 * 输入值先除以比例因子得到协议原始值，再按照字典数据类型和字节序编码。
 * @param item 寄存器字典条目。
 * @param text 用户输入的解析值文本。
 * @returns 可直接写入协议或 Server 数据区的寄存器数组。
 */
export function encodeRegisterValue(item: RegisterDefinition, text: string): number[] {
  const displayedValue = Number(text.trim())
  if (!Number.isFinite(displayedValue)) throw new Error('请输入有效数值')
  const factor = Number.isFinite(item.factor) && item.factor !== 0 ? item.factor : 1
  const rawValue = displayedValue / factor
  if (item.dataType === 'BIT') return [rawValue ? 1 : 0]
  if (item.dataType.startsWith('FLOAT_')) return encodeFloat(item.dataType, rawValue)
  if (!Number.isInteger(rawValue)) throw new Error('当前数据类型换算后的原始值必须为整数')
  if (item.dataType === 'BCD') {
    const digits = String(rawValue)
    const expectedDigits = Math.max(1, item.length) * 4
    if (!/^\d+$/.test(digits) || digits.length > expectedDigits) throw new Error(`BCD 最多允许 ${expectedDigits} 位十进制数字`)
    const padded = digits.padStart(expectedDigits, '0')
    return Array.from({ length: Math.max(1, item.length) }, (_, index) => Number.parseInt(padded.slice(index * 4, index * 4 + 4), 16))
  }
  if (item.dataType === 'INT16') {
    if (rawValue < -0x8000 || rawValue > 0x7fff) throw new Error('INT16 原始值超出范围')
    return [rawValue & 0xffff]
  }
  if (item.dataType === 'UINT32' || item.dataType === 'INT32') {
    const min = item.dataType === 'INT32' ? -0x80000000 : 0
    const max = item.dataType === 'INT32' ? 0x7fffffff : 0xffffffff
    if (rawValue < min || rawValue > max) throw new Error(`${item.dataType} 原始值超出范围`)
    const unsigned = rawValue < 0 ? rawValue + 0x100000000 : rawValue
    return [Math.floor(unsigned / 0x10000) & 0xffff, unsigned & 0xffff]
  }
  if (rawValue < 0 || rawValue > 0xffff) throw new Error('UINT16 原始值超出范围')
  return [rawValue & 0xffff]
}

/**
 * @brief 解析四字节浮点数。
 * @param dataType 浮点数据类型及字节序。
 * @param values 两个 16 位寄存器。
 * @returns IEEE754 单精度浮点值。
 */
function decodeFloat(dataType: string, values: number[]): number {
  const bytes = [(values[0] >> 8) & 0xff, values[0] & 0xff, ((values[1] ?? 0) >> 8) & 0xff, (values[1] ?? 0) & 0xff]
  const order = dataType.slice(-4).split('').map((letter) => 'ABCD'.indexOf(letter))
  const buffer = new ArrayBuffer(4)
  const view = new DataView(buffer)
  order.forEach((sourceIndex, index) => view.setUint8(index, bytes[sourceIndex]))
  return view.getFloat32(0)
}

/**
 * @brief 编码四字节浮点数。
 * @param dataType 浮点数据类型及字节序。
 * @param value 待编码浮点值。
 * @returns 两个 16 位寄存器。
 */
function encodeFloat(dataType: string, value: number): number[] {
  const buffer = new ArrayBuffer(4)
  const view = new DataView(buffer)
  view.setFloat32(0, value)
  const canonical = [view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3)]
  const order = dataType.slice(-4).split('').map((letter) => 'ABCD'.indexOf(letter))
  const wire = order.map((sourceIndex) => canonical[sourceIndex])
  return [((wire[0] << 8) | wire[1]) & 0xffff, ((wire[2] << 8) | wire[3]) & 0xffff]
}
