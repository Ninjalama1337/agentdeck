import pino from 'pino';

export type Logger = pino.Logger;

/**
 * Creates the root logger. Redacts signed download tokens that appear in
 * request URLs so logs never contain usable credentials.
 */
export function createLogger(level: string): Logger {
  return pino({
    level,
    serializers: {
      req(req: { method?: string; url?: string }) {
        const url = (req.url ?? '').replace(/([?&])token=[^&]*/g, '$1token=[redacted]');
        return { method: req.method, url };
      },
    },
    transport: process.stdout.isTTY
      ? {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
        }
      : undefined,
  });
}
