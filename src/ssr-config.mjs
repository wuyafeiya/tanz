import { readFile } from 'node:fs/promises'

/**
 * @typedef {Object} SsrNode
 * @property {string} id
 * @property {string} name
 * @property {string} server
 * @property {number} port
 * @property {string} cipher
 * @property {string} password
 * @property {string} protocol
 * @property {string} obfs
 * @property {string=} protocolParam
 * @property {string=} obfsParam
 * @property {boolean=} udp
 */

/**
 * @param {string} filePath
 * @returns {Promise<SsrNode[]>}
 */
export async function loadSsrNodes(filePath) {
  const raw = await readFile(filePath, 'utf8')
  const data = JSON.parse(raw)

  if (!Array.isArray(data)) {
    throw new Error('SSR 配置文件必须是节点数组')
  }

  return data.map(validateSsrNode)
}

/**
 * @param {unknown} value
 * @returns {SsrNode}
 */
function validateSsrNode(value) {
  if (!value || typeof value !== 'object') {
    throw new Error('SSR 节点配置格式错误')
  }

  const node = /** @type {Record<string, unknown>} */ (value)
  const requiredTextFields = ['name', 'server', 'password', 'protocol', 'obfs']

  for (const field of requiredTextFields) {
    if (typeof node[field] !== 'string' || node[field].trim() === '') {
      throw new Error(`SSR 节点字段无效: ${field}`)
    }
  }

  if (typeof node.port !== 'number' || !Number.isInteger(node.port) || node.port <= 0) {
    throw new Error('SSR 节点字段无效: port')
  }

  const cipher = asOptionalText(node.cipher) ?? asOptionalText(node.method)
  if (!cipher) {
    throw new Error('SSR 节点字段无效: cipher/method')
  }

  const id = asOptionalText(node.id) ?? String(node.name)
  return {
    id,
    name: String(node.name),
    server: String(node.server),
    port: node.port,
    cipher,
    password: String(node.password),
    protocol: String(node.protocol),
    obfs: String(node.obfs),
    protocolParam: asOptionalText(node.protocolParam) ?? asOptionalText(node['protocol-param']),
    obfsParam: asOptionalText(node.obfsParam) ?? asOptionalText(node['obfs-param']),
    udp: typeof node.udp === 'boolean' ? node.udp : undefined,
  }
}

/**
 * @param {unknown} value
 */
function asOptionalText(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}
