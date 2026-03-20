import { readFile } from 'node:fs/promises'

/**
 * @typedef {'ss' | 'ssr'} NodeType
 */

/**
 * @typedef {Object} ProbeNode
 * @property {string} id
 * @property {string} name
 * @property {NodeType} type
 * @property {string} server
 * @property {number} port
 * @property {string} method
 * @property {string} password
 * @property {string=} protocol
 * @property {string=} protocolParam
 * @property {string=} obfs
 * @property {string=} obfsParam
 * @property {string=} binary
 * @property {string=} remarks
 */

/**
 * @param {string} filePath
 * @returns {Promise<ProbeNode[]>}
 */
export async function loadNodes(filePath) {
  const raw = await readFile(filePath, 'utf8')
  const data = JSON.parse(raw)

  if (!Array.isArray(data)) {
    throw new Error('配置文件必须是节点数组')
  }

  return data.map(validateNode)
}

/**
 * @param {unknown} value
 * @returns {ProbeNode}
 */
function validateNode(value) {
  if (!value || typeof value !== 'object') {
    throw new Error('节点配置格式错误')
  }

  const node = /** @type {Record<string, unknown>} */ (value)
  const requiredTextFields = ['id', 'name', 'type', 'server', 'method', 'password']

  for (const field of requiredTextFields) {
    if (typeof node[field] !== 'string' || node[field].trim() === '') {
      throw new Error(`节点字段无效: ${field}`)
    }
  }

  if (node.type !== 'ss' && node.type !== 'ssr') {
    throw new Error(`不支持的节点类型: ${String(node.type)}`)
  }

  if (typeof node.port !== 'number' || !Number.isInteger(node.port) || node.port <= 0) {
    throw new Error('节点字段无效: port')
  }

  return /** @type {ProbeNode} */ ({
    id: node.id,
    name: node.name,
    type: node.type,
    server: node.server,
    port: node.port,
    method: node.method,
    password: node.password,
    protocol: asOptionalText(node.protocol),
    protocolParam: asOptionalText(node.protocolParam),
    obfs: asOptionalText(node.obfs),
    obfsParam: asOptionalText(node.obfsParam),
    binary: asOptionalText(node.binary),
    remarks: asOptionalText(node.remarks),
  })
}

/**
 * @param {unknown} value
 */
function asOptionalText(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}
