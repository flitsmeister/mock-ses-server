'use strict'

const http = require('http')
const querystring = require('querystring')
const util = require('util')
const mailparser = require('mailparser').simpleParser

const { WaitGroup } = require('./sync-wait-group')

/** @typedef {{
      id: string;
      body: Record<string, string>;
    }} EmailInfo
 */

/** @typedef {{
      (err?: Error): void
    }} Callback
 */

class FakeSESServer {
  /**
   * @param {{ port?: number }} options
   */
  constructor (options = { port: process.argv[2] }) {
    /** @type {EmailInfo[]} */
    this.emails = []

    /** @type {http.Server | null} */
    this.httpServer = http.createServer()
    /** @type {number} */
    this.port = options.port || 0
    /** @type {string | null} */
    this.hostPort = null

    /** @type {number} */
    this.emailCount = 0
    /** @type {(WaitGroup | null)[]} */
    this.waiters = []
    /** @type {boolean[]} */
    this.emailErrors = []
  }

  /** @returns {Promise<string>} */
  async bootstrap () {
    if (!this.httpServer) {
      throw new Error('cannot bootstrap closed server')
    }

    this.httpServer.on('request', async (req, res) => {
      if (req.url === '/emails') {
          if (req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(await this.getEmails()))
          }

          if (req.method === 'DELETE') {
            this.clearEmails()
            res.writeHead(200)
            res.end()
          }
      } else if (req.url === '/errors' && req.method === 'POST') {
        let body = ''
        req.on('data', (chunk) => {
          body += chunk.toString()
        })
        req.on('end', () => {
          const errors = JSON.parse(body)
          this.setEmailErrors(errors)
          res.writeHead(200)
          res.end()
        })
      } else {
        this.handleServerRequest(req, res)
      }
    })

    const server = this.httpServer
    await util.promisify((cb) => {
      server.listen(this.port, cb)
    })()

    const addr = this.httpServer.address()
    if (!addr || typeof addr === 'string') {
      throw new Error('invalid http server address')
    }

    this.hostPort = `localhost:${addr.port}`
    return this.hostPort
  }

  /** @returns {Promise<void>} */
  async close () {
    if (this.httpServer === null) {
      return
    }

    const server = this.httpServer
    await util.promisify((cb) => {
      server.close(cb)
    })()
    this.httpServer = null
  }

  /** @returns {Promise<EmailInfo[]>} */
  async getEmails () {
    const emails = this.emails
      .slice()
      .reverse()

    const parsedEmails = []

    for (const email of emails) {
      const parsedEmail = await mailparser(Buffer.from(email.body['RawMessage.Data'], 'base64').toString())
      parsedEmails.push(parsedEmail)
    }

    return parsedEmails
  }

  clearEmails() {
    this.emails = []
    this.emailCount = 0
  }

  /** @param {boolean[]} errors */
  setEmailErrors(errors) {
    this.emailErrors.push(...errors)
  }

  /**
   * @param {number} count
   * @returns {Promise<void>}
   */
  async waitForEmails (count) {
    if (this.emailCount >= count) {
      return
    }

    const maybeWaiter = this.waiters[count]
    if (maybeWaiter) {
      return maybeWaiter.wait()
    }

    const w = this.waiters[count] = new WaitGroup()
    w.add(1)
    return w.wait()
  }

  /**
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   * @returns {void}
   */
  handleServerRequest (req, res) {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk.toString()
    })
    req.on('end', () => {
      const params = /** @type {Record<string, string>} */ (
        querystring.parse(body)
      )
      const xml = this.handleMessage(params.Action, params)
      if (!xml) {
        res.statusCode = 404
        res.end('Not Found')
      } else {
        res.writeHead(200, { 'Content-Type': 'text/xml' })
        res.end(xml)
      }
    })
  }

  /**
   * @param {string} action
   * @param {Record<string, string>} params
   * @returns {null | string}
   */
  handleMessage (action, params) {
    if (this.emailErrors.length > 0) {
      const isError = this.emailErrors.shift()

      if (isError)
        return null
    }

    switch (action) {
      case 'SendEmail':
        return this.handleEmail(params)

      case 'SendRawEmail':
        return this.handleRawEmail(params)

      default:
        return null
    }
  }

  /**
   * @param {Record<string, string>} params
   * @returns {string}
   */
  handleEmail (params) {
    if (!params.Source ||
      !params['Message.Subject.Data'] ||
      !(
        params['Message.Body.Html.Data'] ||
        params['Message.Body.Text.Data']
      ) ||
      !params['Destination.ToAddresses.member.1']
    ) {
      return `<Error>
        <Code>MessageRejected</Code>
        <Message>Missing required params</Message>
      </Error>`
    }

    const id = cuuid()
    this.emails.push({
      id,
      body: params
    })

    this.emailCount++
    this.checkWaiters()

    return `<SendEmailResponse>
      <SendEmailResult>
        <MessageId>${id}</MessageId>
      </SendEmailResult>
    </SendEmailResponse>`
  }

  /**
   * @param {Record<string, string>} params
   * @returns {string}
   */
  handleRawEmail (params) {
    if (!params['RawMessage.Data']) {
      return `<Error>
        <Code>MessageRejected</Code>
        <Message>Missing required params</Message>
      </Error>`
    }

    const id = cuuid()
    this.emails.push({
      id,
      body: params
    })

    this.emailCount++
    this.checkWaiters()

    return `<SendRawEmailResponse>
      <SendRawEmailResult>
        <MessageId>${id}</MessageId>
      </SendRawEmailResult>
    </SendRawEmailResponse>`
  }

  /** @returns {void} */
  checkWaiters () {
    const w = this.waiters[this.emailCount]
    if (w) {
      this.waiters[this.emailCount] = null
      w.done()
    }
  }
}

const server = new FakeSESServer()
server.bootstrap()

exports.FakeSESServer = FakeSESServer

/** @returns {string} */
function cuuid () {
  const str = (
    Date.now().toString(16) + Math.random().toString(16).slice(2) +
    Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2)
  ).slice(0, 32)
  return str.slice(0, 8) + '-' + str.slice(8, 12) + '-' +
    str.slice(12, 16) + '-' + str.slice(16, 20) + '-' + str.slice(20)
}
