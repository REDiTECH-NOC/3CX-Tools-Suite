function timestamp(): string {
  return new Date().toISOString();
}

export const log = {
  info(msg: string) {
    console.log(`[${timestamp()}] [INFO] ${msg}`);
  },
  warn(msg: string) {
    console.warn(`[${timestamp()}] [WARN] ${msg}`);
  },
  error(msg: string) {
    console.error(`[${timestamp()}] [ERROR] ${msg}`);
  },
};
