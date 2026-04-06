export type Job = {
  jid: string
  text: string
  input: string
  sessionId?: string
  senderNumber: string
  fromMe: boolean
  role?: string
  allowedTools?: string[] | 'all'
}

export type Result = {
  reply: string
}
