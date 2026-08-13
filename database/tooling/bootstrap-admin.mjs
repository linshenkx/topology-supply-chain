import crypto from "node:crypto";
import process from "node:process";
import readline from "node:readline";
import mysql from "mysql2/promise";

const COMPANY_NAME = "广州拓扑睡眠科技有限公司";
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MOBILE_PATTERN = /^1\d{10}$/;

function readVisible(prompt) {
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => terminal.question(prompt, (answer) => {
    terminal.close();
    resolve(answer.trim());
  }));
}

function readSecret(prompt) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("必须在交互式服务器终端中运行，禁止通过命令参数或管道传入密码。");
  }
  return new Promise((resolve, reject) => {
    let value = "";
    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
    };
    const onData = (chunk) => {
      const text = chunk.toString("utf8");
      if (text === "\u0003") {
        cleanup();
        process.stdout.write("\n");
        reject(new Error("操作已取消。"));
        return;
      }
      if (text === "\r" || text === "\n") {
        cleanup();
        process.stdout.write("\n");
        resolve(value);
        return;
      }
      if (text === "\u007f" || text === "\b") {
        value = value.slice(0, -1);
        return;
      }
      if (/^[\x20-\x7E]+$/.test(text)) value += text;
    };
    process.stdout.write(prompt);
    process.stdin.resume();
    process.stdin.setRawMode(true);
    process.stdin.on("data", onData);
  });
}

function validatePassword(value) {
  if (value.length < 12) return "密码至少需要12位。";
  if (!/[A-Z]/.test(value) || !/[a-z]/.test(value) || !/\d/.test(value) || !/[^A-Za-z0-9]/.test(value)) {
    return "密码必须同时包含大写字母、小写字母、数字和特殊字符。";
  }
  return null;
}

function hashPassword(password, saltHex) {
  return crypto.pbkdf2Sync(password, Buffer.from(saltHex, "hex"), 210000, 32, "sha256").toString("hex");
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl?.startsWith("mysql://")) {
    throw new Error("未读取到 DATABASE_URL。请先加载生产环境配置，再运行本工具。");
  }

  const email = (await readVisible("管理员邮箱：")).toLowerCase();
  if (!EMAIL_PATTERN.test(email)) throw new Error("邮箱格式不正确。");
  const name = await readVisible("管理员姓名：");
  if (!name) throw new Error("管理员姓名不能为空。");
  const mobile = await readVisible("管理员手机号（11位）：");
  if (!MOBILE_PATTERN.test(mobile)) throw new Error("手机号格式不正确。");
  const password = await readSecret("初始密码（输入时不显示）：");
  const passwordError = validatePassword(password);
  if (passwordError) throw new Error(passwordError);
  const confirmation = await readSecret("再次输入初始密码：");
  if (confirmation !== password) throw new Error("两次输入的密码不一致。");

  const pool = mysql.createPool({
    uri: databaseUrl,
    connectionLimit: 1,
    timezone: "+08:00",
    dateStrings: true,
    ssl: process.env.DB_SSL === "disabled"
      ? undefined
      : { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== "false" },
  });
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [adminRows] = await connection.query(
      "SELECT COUNT(*) AS total FROM user_roles WHERE role_code = 'admin' AND status = 'active'",
    );
    if (Number(adminRows[0].total) > 0) {
      throw new Error("系统已经存在有效管理员。后续管理员必须通过系统内双人审批新增。");
    }
    const [existingRows] = await connection.execute("SELECT id FROM users WHERE email = ? LIMIT 1", [email]);
    if (existingRows.length) throw new Error("该邮箱账号已经存在。");

    const salt = crypto.randomBytes(16).toString("hex");
    const passwordHash = hashPassword(password, salt);
    const [userResult] = await connection.execute(
      `INSERT INTO users
        (email, mobile, name, role, organization_name, account_status, created_at, updated_at)
       VALUES (?, ?, ?, 'supply_chain', ?, 'active', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
      [email, mobile, name, COMPANY_NAME],
    );
    const userId = Number(userResult.insertId);
    await connection.execute(
      `INSERT INTO auth_credentials
        (user_id, password_hash, password_salt, failed_attempts, password_changed_at, created_at, updated_at)
       VALUES (?, ?, ?, 0, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
      [userId, passwordHash, salt],
    );
    await connection.execute(
      `INSERT INTO user_roles
        (user_id, role_code, effective_from, status, requested_by, reviewed_by, reviewed_at, created_at, updated_at)
       VALUES (?, 'admin', CURRENT_DATE(), 'active', ?, ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
      [userId, userId, userId],
    );
    await connection.execute(
      `INSERT INTO audit_logs
        (actor_user_id, action, module, entity_type, entity_id, after_json, sensitive_view, exported, created_at, archive_after)
       VALUES (?, 'bootstrap', 'identity', 'user', ?, ?, 0, 0, CURRENT_TIMESTAMP(3), DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 5 YEAR))`,
      [userId, String(userId), JSON.stringify({ email, name, mobileMasked: `${mobile.slice(0, 3)}****${mobile.slice(-4)}`, roles: ["supply_chain", "admin"] })],
    );
    await connection.commit();
    process.stdout.write(`\n首位管理员已创建：${email}\n`);
    process.stdout.write("首次登录属于新设备，将按规则要求手机验证码；短信服务未配置前暂不能完成生产登录。\n");
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`初始化失败：${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
