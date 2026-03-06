import { NodeSSH } from "node-ssh";
import { log } from "./logger.js";
import type { TaskPayload } from "./api-client.js";

/**
 * Deploy SSO files to a 3CX PBX via SSH/SFTP.
 * Connects, writes each file via SFTP, verifies they exist, disconnects.
 */
export async function deploySsoFiles(payload: TaskPayload): Promise<void> {
  const ssh = new NodeSSH();
  const label = `${payload.instanceName || payload.localIp} (${payload.fqdn || ""})`;

  log.info(`Connecting to ${payload.localIp} as ${payload.sshUsername}...`);

  await ssh.connect({
    host: payload.localIp,
    username: payload.sshUsername,
    password: payload.sshPassword,
    readyTimeout: 10_000,
    // PBXs are on the LAN — accept unknown host keys
    algorithms: {
      serverHostKey: [
        "ssh-ed25519",
        "ecdsa-sha2-nistp256",
        "ecdsa-sha2-nistp384",
        "ecdsa-sha2-nistp521",
        "rsa-sha2-512",
        "rsa-sha2-256",
        "ssh-rsa",
      ],
    },
  });

  try {
    // Ensure target directory exists
    const mkdirResult = await ssh.execCommand(
      `mkdir -p '${payload.targetPath}'`
    );
    if (mkdirResult.code !== 0) {
      throw new Error(`Failed to create directory: ${mkdirResult.stderr}`);
    }

    if (!payload.files?.length) {
      throw new Error("No files provided in task payload");
    }

    // Write each file via SFTP
    const sftp = await ssh.requestSFTP();

    for (const file of payload.files) {
      const remotePath = `${payload.targetPath}${file.name}`;
      log.info(`Writing ${file.name} to ${remotePath}...`);

      await new Promise<void>((resolve, reject) => {
        const stream = sftp.createWriteStream(remotePath);
        stream.on("close", () => resolve());
        stream.on("error", (err: Error) => reject(err));
        stream.end(Buffer.from(file.content, "utf-8"));
      });
    }

    // Verify all files exist
    for (const file of payload.files) {
      const remotePath = `${payload.targetPath}${file.name}`;
      const check = await ssh.execCommand(
        `test -f '${remotePath}' && echo OK`
      );
      if (!check.stdout.includes("OK")) {
        throw new Error(
          `Verification failed: ${file.name} not found after deployment`
        );
      }
    }

    log.info(`SSO files deployed to ${label}`);
  } finally {
    ssh.dispose();
  }
}

/**
 * Remove SSO files from a 3CX PBX via SSH.
 */
export async function removeSsoFiles(payload: TaskPayload): Promise<void> {
  const ssh = new NodeSSH();
  const label = `${payload.instanceName || payload.localIp} (${payload.fqdn || ""})`;

  log.info(`Connecting to ${payload.localIp} as ${payload.sshUsername}...`);

  await ssh.connect({
    host: payload.localIp,
    username: payload.sshUsername,
    password: payload.sshPassword,
    readyTimeout: 10_000,
    algorithms: {
      serverHostKey: [
        "ssh-ed25519",
        "ecdsa-sha2-nistp256",
        "ecdsa-sha2-nistp384",
        "ecdsa-sha2-nistp521",
        "rsa-sha2-512",
        "rsa-sha2-256",
        "ssh-rsa",
      ],
    },
  });

  try {
    if (!payload.fileNames?.length) {
      throw new Error("No file names provided for removal");
    }

    for (const fileName of payload.fileNames) {
      const remotePath = `${payload.targetPath}${fileName}`;
      log.info(`Removing ${remotePath}...`);

      const result = await ssh.execCommand(`rm -f '${remotePath}'`);
      if (result.code !== 0) {
        throw new Error(`Failed to remove ${fileName}: ${result.stderr}`);
      }
    }

    // Verify files are gone
    for (const fileName of payload.fileNames) {
      const remotePath = `${payload.targetPath}${fileName}`;
      const check = await ssh.execCommand(
        `test -f '${remotePath}' && echo EXISTS || echo GONE`
      );
      if (check.stdout.includes("EXISTS")) {
        throw new Error(`Removal failed: ${fileName} still exists`);
      }
    }

    log.info(`SSO files removed from ${label}`);
  } finally {
    ssh.dispose();
  }
}

/**
 * Deploy 3CX Tools Suite relay agent to a PBX via SSH.
 * Runs the install script non-interactively with the provided config.
 */
export async function deploy3cxTools(payload: TaskPayload): Promise<void> {
  const ssh = new NodeSSH();
  const label = `${payload.instanceName || payload.localIp} (${payload.fqdn || ""})`;

  log.info(`Connecting to ${payload.localIp} as ${payload.sshUsername} for 3CX Tools install...`);

  await ssh.connect({
    host: payload.localIp,
    username: payload.sshUsername,
    password: payload.sshPassword,
    readyTimeout: 10_000,
    algorithms: {
      serverHostKey: [
        "ssh-ed25519",
        "ecdsa-sha2-nistp256",
        "ecdsa-sha2-nistp384",
        "ecdsa-sha2-nistp521",
        "rsa-sha2-512",
        "rsa-sha2-256",
        "ssh-rsa",
      ],
    },
  });

  try {
    // Build install command with all flags for non-interactive mode
    const args = [
      `--wallboard-url '${payload.wallboardUrl}'`,
      `--api-key '${payload.wallboardApiKey}'`,
      `--pbx-url 'https://localhost:5001'`,
      `--pbx-ext '${payload.pbxExtension}'`,
      `--pbx-pass '${payload.pbxPassword}'`,
    ];

    if (payload.autoPagerUrl) {
      args.push(`--autopager-url '${payload.autoPagerUrl}'`);
    }
    if (payload.autoPagerApiKey) {
      args.push(`--autopager-key '${payload.autoPagerApiKey}'`);
    }

    const installCmd = `curl -sSL https://raw.githubusercontent.com/REDiTECH-NOC/3CX-Tools-Suite/main/3cxtools-relay/install.sh | bash -s -- ${args.join(" ")}`;

    log.info(`Running install script on ${label}...`);
    const result = await ssh.execCommand(installCmd, { execOptions: { pty: true } });

    log.info(`Install stdout: ${result.stdout.slice(-500)}`);
    if (result.stderr) {
      log.warn(`Install stderr: ${result.stderr.slice(-500)}`);
    }

    if (result.code !== 0 && result.code !== null) {
      throw new Error(`Install script exited with code ${result.code}: ${result.stderr || result.stdout}`);
    }

    // Verify the service is running
    const check = await ssh.execCommand("systemctl is-active 3cxtools-relay");
    if (!check.stdout.trim().includes("active")) {
      throw new Error(`3cxtools-relay service is not active after install. Status: ${check.stdout.trim()}`);
    }

    log.info(`3CXTools-Relay deployed to ${label}`);
  } finally {
    ssh.dispose();
  }
}

/**
 * Remove 3CX Tools Suite relay agent from a PBX via SSH.
 * Runs the uninstall script non-interactively.
 */
export async function remove3cxTools(payload: TaskPayload): Promise<void> {
  const ssh = new NodeSSH();
  const label = `${payload.instanceName || payload.localIp} (${payload.fqdn || ""})`;

  log.info(`Connecting to ${payload.localIp} as ${payload.sshUsername} for 3CX Tools removal...`);

  await ssh.connect({
    host: payload.localIp,
    username: payload.sshUsername,
    password: payload.sshPassword,
    readyTimeout: 10_000,
    algorithms: {
      serverHostKey: [
        "ssh-ed25519",
        "ecdsa-sha2-nistp256",
        "ecdsa-sha2-nistp384",
        "ecdsa-sha2-nistp521",
        "rsa-sha2-512",
        "rsa-sha2-256",
        "ssh-rsa",
      ],
    },
  });

  try {
    const uninstallCmd = `curl -sSL https://raw.githubusercontent.com/REDiTECH-NOC/3CX-Tools-Suite/main/3cxtools-relay/uninstall.sh | bash -s -- --yes`;

    log.info(`Running uninstall script on ${label}...`);
    const result = await ssh.execCommand(uninstallCmd, { execOptions: { pty: true } });

    log.info(`Uninstall stdout: ${result.stdout.slice(-500)}`);
    if (result.stderr) {
      log.warn(`Uninstall stderr: ${result.stderr.slice(-500)}`);
    }

    if (result.code !== 0 && result.code !== null) {
      throw new Error(`Uninstall script exited with code ${result.code}: ${result.stderr || result.stdout}`);
    }

    // Verify the service is gone
    const check = await ssh.execCommand("systemctl is-active 3cxtools-relay 2>/dev/null || echo inactive");
    if (check.stdout.trim() === "active") {
      throw new Error("3cxtools-relay service is still active after uninstall");
    }

    log.info(`3CXTools-Relay removed from ${label}`);
  } finally {
    ssh.dispose();
  }
}
