const http = require("http");
const https = require("https");
const { ethers } = require("ethers");
const { Pool } = require("pg");
const { google } = require("googleapis");

const PORT = process.env.PORT || 3000;
const DATABASE_URL =
  String(process.env.DATABASE_URL || "").trim();
/* =========================
   POSTGRESQL
========================= */

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

/* =========================
   PAYMENT SETTINGS
========================= */

const PAYMENT_WALLET =
  "0x07207Bf282B4e3dc2db376F29e40bfbc7d61607B".toLowerCase();

const RPC_URL =
  "https://bsc-dataseed.bnbchain.org";

const USDT_CONTRACT =
  "0x55d398326f99059ff775485246999027b3197955".toLowerCase();

const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/* =========================
   PAYOUT SETTINGS
========================= */

const PAYOUT_WALLET =
  String(process.env.PAYOUT_WALLET || "").toLowerCase();

const PAYOUT_PRIVATE_KEY =
  String(process.env.PAYOUT_PRIVATE_KEY || "");

const PAYOUT_API_SECRET =
  String(process.env.PAYOUT_API_SECRET || "");

let MIN_WITHDRAW =
  Number(process.env.MIN_WITHDRAW || 0.15);

if (!Number.isFinite(MIN_WITHDRAW) || MIN_WITHDRAW <= 0) {
  MIN_WITHDRAW = 0.15;
}

let payoutBusy = false;
const processedPayouts = new Set();

/* =========================
   YOUTUBE SETTINGS
========================= */

const YOUTUBE_CLIENT_ID =
  String(process.env.YOUTUBE_CLIENT_ID || "").trim();

const YOUTUBE_CLIENT_SECRET =
  String(process.env.YOUTUBE_CLIENT_SECRET || "").trim();

const YOUTUBE_OAUTH_SECRET =
  String(process.env.YOUTUBE_OAUTH_SECRET || "").trim();

const YOUTUBE_REDIRECT_URI =
  String(
    process.env.YOUTUBE_REDIRECT_URI ||
    "https://telegram-bot-backend-production-c04c.up.railway.app/youtube/callback"
  ).trim();

const YOUTUBE_SCOPES = [
  "https://www.googleapis.com/auth/youtube.readonly"
];

/* =========================
   TELEGRAM VERIFICATION
========================= */

const TELEGRAM_BOT_TOKEN =
  String(process.env.TELEGRAM_BOT_TOKEN || "").trim();

const TELEGRAM_API =
  TELEGRAM_BOT_TOKEN
    ? "https://api.telegram.org/bot" + TELEGRAM_BOT_TOKEN
    : "";

/* =========================
   YOUTUBE CONFIG
========================= */

function youtubeConfigured() {
  return !!(
    YOUTUBE_CLIENT_ID &&
    YOUTUBE_CLIENT_SECRET &&
    YOUTUBE_OAUTH_SECRET &&
    YOUTUBE_REDIRECT_URI
  );
}

function createYoutubeOAuthClient() {
  if (!youtubeConfigured()) {
    throw new Error(
      "YouTube OAuth variables are not fully configured"
    );
  }

  return new google.auth.OAuth2(
    YOUTUBE_CLIENT_ID,
    YOUTUBE_CLIENT_SECRET,
    YOUTUBE_REDIRECT_URI
  );
}

/* =========================
   DATABASE TEST
========================= */

async function testDatabase() {
  try {
    const result =
      await db.query("SELECT NOW()");

    console.log(
      "PostgreSQL connected:",
      result.rows[0].now
    );
  } catch (error) {
    console.error(
      "PostgreSQL connection error:",
      error.message
    );
  }
}

/* =========================
   TASK DATABASE FUNCTIONS
========================= */

async function getTasks() {
  const result =
    await db.query(`
      SELECT
        id,
        task_id,
        title,
        description,
        link,
        reward,
        status,
        COALESCE(verification_type, 'manual') AS verification_type,
        COALESCE(verification_target, '') AS verification_target
      FROM "Task Plan Bot"
      ORDER BY task_id ASC
    `);

  return result.rows;
}

async function getTask(taskId) {
  const result =
    await db.query(
      `
      SELECT
        id,
        task_id,
        title,
        description,
        link,
        reward,
        status,
        COALESCE(verification_type, 'manual') AS verification_type,
        COALESCE(verification_target, '') AS verification_target
      FROM "Task Plan Bot"
      WHERE task_id = $1
      LIMIT 1
      `,
      [Number(taskId)]
    );

  return result.rows[0] || null;
}

async function addTask(
  taskId,
  title,
  description,
  link,
  reward,
  status,
  verificationType,
  verificationTarget
) {
  const result =
    await db.query(
      `
      INSERT INTO "Task Plan Bot"
        (
          task_id,
          title,
          description,
          link,
          reward,
          status,
          verification_type,
          verification_target
        )
      VALUES
        ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING
        id,
        task_id,
        title,
        description,
        link,
        reward,
        status,
        verification_type,
        verification_target
      `,
      [
        Number(taskId),
        String(title),
        String(description || ""),
        String(link || ""),
        Number(reward || 0.05),
        String(status || "active"),
        String(verificationType || "manual"),
        String(verificationTarget || "")
      ]
    );

  return result.rows[0];
}

async function updateTask(
  taskId,
  title,
  description,
  link,
  reward,
  status,
  verificationType,
  verificationTarget
) {
  const result =
    await db.query(
      `
      UPDATE "Task Plan Bot"
      SET
        title = $2,
        description = $3,
        link = $4,
        reward = $5,
        status = $6,
        verification_type = $7,
        verification_target = $8
      WHERE task_id = $1
      RETURNING
        id,
        task_id,
        title,
        description,
        link,
        reward,
        status,
        verification_type,
        verification_target
      `,
      [
        Number(taskId),
        String(title),
        String(description || ""),
        String(link || ""),
        Number(reward || 0.05),
        String(status || "active"),
        String(verificationType || "manual"),
        String(verificationTarget || "")
      ]
    );

  return result.rows[0] || null;
}

async function deleteTask(taskId) {
  const result =
    await db.query(
      `
      DELETE FROM "Task Plan Bot"
      WHERE task_id = $1
      RETURNING
        id,
        task_id,
        title,
        description,
        link,
        reward,
        status,
        verification_type,
        verification_target
      `,
      [Number(taskId)]
    );

  return result.rows[0] || null;
}

/* =========================
   TASK COMPLETION DATABASE
========================= */

async function ensureTaskCompletionTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS task_completions (
      id BIGSERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      task_id INTEGER NOT NULL,
      reward NUMERIC NOT NULL DEFAULT 0,
      verification_type TEXT NOT NULL DEFAULT 'manual',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, task_id)
    )
  `);
}

async function taskAlreadyCompleted(
  userId,
  taskId
) {
  const result =
    await db.query(
      `
      SELECT id
      FROM task_completions
      WHERE user_id = $1
        AND task_id = $2
      LIMIT 1
      `,
      [
        String(userId),
        Number(taskId)
      ]
    );

  return result.rows.length > 0;
}

async function saveTaskCompletion(
  userId,
  taskId,
  reward,
  verificationType
) {
  const result =
    await db.query(
      `
      INSERT INTO task_completions
        (
          user_id,
          task_id,
          reward,
          verification_type
        )
      VALUES
        ($1,$2,$3,$4)
      ON CONFLICT
        (user_id, task_id)
      DO NOTHING
      RETURNING
        id,
        user_id,
        task_id,
        reward
      `,
      [
        String(userId),
        Number(taskId),
        Number(reward || 0),
        String(
          verificationType ||
          "manual"
        )
      ]
    );

  return result.rows[0] || null;
}

/* =========================
   YOUTUBE HELPERS
========================= */

function extractYouTubeChannelId(value) {
  const text =
    String(value || "").trim();

  if (
    /^UC[a-zA-Z0-9_-]{20,}$/.test(text)
  ) {
    return text;
  }

  const match =
    text.match(
      /youtube\.com\/channel\/(UC[a-zA-Z0-9_-]+)/i
    );

  if (match) {
    return match[1];
  }

  return "";
}

async function getYoutubeChannelIdFromUrl(
  urlValue
) {
  const direct =
    extractYouTubeChannelId(urlValue);

  if (direct) {
    return direct;
  }

  const text =
    String(urlValue || "").trim();

  const handleMatch =
    text.match(
      /youtube\.com\/@([a-zA-Z0-9._-]+)/i
    );

  if (
    !handleMatch ||
    !handleMatch[1]
  ) {
    throw new Error(
      "YouTube channel URL is invalid"
    );
  }

  const handle =
    handleMatch[1];

  const response =
    await google.youtube(
      {
        version: "v3",
        auth: YOUTUBE_CLIENT_ID
      }
    ).channels.list({
      part: "id",
      forHandle: handle
    });

  if (
    !response.data.items ||
    !response.data.items.length
  ) {
    throw new Error(
      "YouTube channel not found"
    );
  }

  return response.data.items[0].id;
}

async function verifyYoutubeSubscription(
  oauthClient,
  targetChannelId
) {
  const youtube =
    google.youtube({
      version: "v3",
      auth: oauthClient
    });

  const response =
    await youtube.subscriptions.list({
      part: "snippet",
      mine: true,
      maxResults: 50
    });

  const items =
    response.data.items || [];

  const found =
    items.some(
      (item) =>
        item &&
        item.snippet &&
        item.snippet.resourceId &&
        item.snippet.resourceId.channelId ===
          targetChannelId
    );

  return {
    verified: found
  };
}

/* =========================
   TELEGRAM HELPERS
========================= */

function extractTelegramChatTarget(
  value
) {
  const text =
    String(value || "").trim();

  if (!text) {
    return "";
  }

  if (
    /^@[a-zA-Z0-9_]{5,}$/.test(text)
  ) {
    return text;
  }

  let match =
    text.match(
      /^(?:https?:\/\/)?t\.me\/([a-zA-Z0-9_]{5,})\/?$/i
    );

  if (match) {
    return "@" + match[1];
  }

  match =
    text.match(
      /^(?:https?:\/\/)?telegram\.me\/([a-zA-Z0-9_]{5,})\/?$/i
    );

  if (match) {
    return "@" + match[1];
  }

  return "";
}

function telegramApi(
  method,
  payload
) {
  return new Promise(
    (resolve, reject) => {
      if (!TELEGRAM_API) {
        reject(
          new Error(
            "TELEGRAM_BOT_TOKEN is not configured"
          )
        );
        return;
      }

      const data =
        JSON.stringify(payload || {});

      const url =
        TELEGRAM_API +
        "/" +
        method;

      const request =
        https.request(
          url,
          {
            method: "POST",
            headers: {
              "Content-Type":
                "application/json",
              "Content-Length":
                Buffer.byteLength(data)
            }
          },
          (response) => {
            let body = "";

            response.on(
              "data",
              (chunk) => {
                body += chunk;
              }
            );

            response.on(
              "end",
              () => {
                try {
                  const parsed =
                    JSON.parse(body);

                  if (
                    parsed &&
                    parsed.ok
                  ) {
                    resolve(
                      parsed.result
                    );
                  } else {
                    reject(
                      new Error(
                        parsed &&
                        parsed.description
                          ? parsed.description
                          : "Telegram API error"
                      )
                    );
                  }
                } catch (error) {
                  reject(
                    new Error(
                      "Invalid Telegram API response"
                    )
                  );
                }
              }
            );
          }
        );

      request.on(
        "error",
        reject
      );

      request.write(data);
      request.end();
    }
  );
}

async function telegramCheckMembership(
  chatTarget,
  userId
) {
  const member =
    await telegramApi(
      "getChatMember",
      {
        chat_id: chatTarget,
        user_id: Number(userId)
      }
    );

  if (!member) {
    return false;
  }

  if (
    member.status ===
      "creator" ||
    member.status ===
      "administrator" ||
    member.status ===
      "member"
  ) {
    return true;
  }

  if (
    member.status ===
      "restricted" &&
    member.is_member === true
  ) {
    return true;
  }

  return false;
}

async function verifyTelegramTask(
  userId,
  taskId
) {
  const task =
    await getTask(taskId);

  if (!task) {
    return {
      success: false,
      verified: false,
      error: "Task not found"
    };
  }

  if (
    String(task.status)
      .toLowerCase() !==
    "active"
  ) {
    return {
      success: false,
      verified: false,
      error: "Task is not active"
    };
  }

  if (
    String(
      task.verification_type
    ).toLowerCase() !==
    "telegram_join"
  ) {
    return {
      success: false,
      verified: false,
      error:
        "This task is not a Telegram join task"
    };
  }

  const chatTarget =
    extractTelegramChatTarget(
      task.verification_target ||
      task.link
    );

  if (!chatTarget) {
    return {
      success: false,
      verified: false,
      error:
        "Telegram channel link is invalid"
    };
  }

  const alreadyCompleted =
    await taskAlreadyCompleted(
      userId,
      taskId
    );

  if (alreadyCompleted) {
    return {
      success: true,
      verified: true,
      already_completed: true,
      task_id: task.task_id,
      reward:
        Number(task.reward || 0),
      channel: chatTarget,
      message:
        "This task has already been completed."
    };
  }

  const isMember =
    await telegramCheckMembership(
      chatTarget,
      userId
    );

  if (!isMember) {
    return {
      success: true,
      verified: false,
      task_id: task.task_id,
      reward:
        Number(task.reward || 0),
      channel: chatTarget,
      message:
        "আপনি এখনো Telegram channel-এ join করেননি। আগে channel-এ join করুন, তারপর আবার Verify করুন।"
    };
  }

  const completion =
    await saveTaskCompletion(
      userId,
      taskId,
      Number(task.reward || 0),
      "telegram_join"
    );

  return {
    success: true,
    verified: true,
    newly_completed:
      !!completion,
    task_id: task.task_id,
    reward:
      Number(task.reward || 0),
    channel: chatTarget,
    message:
      "Telegram membership verified successfully"
  };
}

/* =========================
   REQUEST BODY
========================= */

function readBody(req) {
  return new Promise(
    (resolve, reject) => {
      let body = "";

      req.on(
        "data",
        (chunk) => {
          body += chunk;

          if (
            body.length >
            2 * 1024 * 1024
          ) {
            reject(
              new Error(
                "Request body too large"
              )
            );

            req.destroy();
          }
        }
      );

      req.on(
        "end",
        () => {
          if (!body) {
            resolve({});
            return;
          }

          try {
            resolve(
              JSON.parse(body)
            );
          } catch (error) {
            reject(
              new Error(
                "Invalid JSON body"
              )
            );
          }
        }
      );

      req.on(
        "error",
        reject
      );
    }
  );
}

/* =========================
   JSON RESPONSE
========================= */

function sendJson(
  res,
  statusCode,
  data
) {
  res.writeHead(
    statusCode,
    {
      "Content-Type":
        "application/json; charset=utf-8",
      "Access-Control-Allow-Origin":
        "*",
      "Access-Control-Allow-Methods":
        "GET,POST,PUT,DELETE,OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type, x-api-secret"
    }
  );

  res.end(
    JSON.stringify(data)
  );
}

/* =========================
   RPC REQUEST
========================= */

function rpcRequest(
  method,
  params
) {
  return new Promise(
    (resolve, reject) => {
      const data =
        JSON.stringify({
          jsonrpc: "2.0",
          id: Date.now(),
          method,
          params
        });

      const url =
        new URL(RPC_URL);

      const request =
        https.request(
          {
            hostname:
              url.hostname,
            port:
              url.port || 443,
            path:
              url.pathname +
              (url.search || ""),
            method: "POST",
            headers: {
              "Content-Type":
                "application/json",
              "Content-Length":
                Buffer.byteLength(data)
            }
          },
          (response) => {
            let body = "";

            response.on(
              "data",
              (chunk) => {
                body += chunk;
              }
            );

            response.on(
              "end",
              () => {
                try {
                  const parsed =
                    JSON.parse(body);

                  if (
                    parsed.error
                  ) {
                    reject(
                      new Error(
                        parsed.error.message ||
                        "RPC error"
                      )
                    );
                    return;
                  }

                  resolve(
                    parsed.result
                  );
                } catch (error) {
                  reject(
                    new Error(
                      "Invalid RPC response"
                    )
                  );
                }
              }
            );
          }
        );

      request.on(
        "error",
        reject
      );

      request.write(data);
      request.end();
    }
  );
}
/* =========================
   AUTOMATIC USDT PAYOUT
========================= */

async function sendPayout(
  walletAddress,
  amount,
  clientOid
) {
  if (!PAYOUT_PRIVATE_KEY) {
    throw new Error(
      "PAYOUT_PRIVATE_KEY is missing"
    );
  }

  if (!PAYOUT_WALLET) {
    throw new Error(
      "PAYOUT_WALLET is missing"
    );
  }

  if (!PAYOUT_API_SECRET) {
    throw new Error(
      "PAYOUT_API_SECRET is missing"
    );
  }

  if (
    !/^0x[a-fA-F0-9]{40}$/.test(
      walletAddress
    )
  ) {
    throw new Error(
      "Invalid payout wallet address"
    );
  }

  const payoutAmount =
    Number(amount);

  if (
    !Number.isFinite(payoutAmount) ||
    payoutAmount <= 0
  ) {
    throw new Error(
      "Invalid payout amount"
    );
  }

  if (payoutAmount < MIN_WITHDRAW) {
    throw new Error(
      "Minimum payout is " +
      MIN_WITHDRAW +
      " USDT"
    );
  }

  if (
    !clientOid ||
    String(clientOid).length < 5
  ) {
    throw new Error(
      "Invalid clientOid"
    );
  }

  const provider =
    new ethers.JsonRpcProvider(
      RPC_URL,
      56
    );

  const signer =
    new ethers.Wallet(
      PAYOUT_PRIVATE_KEY,
      provider
    );

  const signerAddress =
    (
      await signer.getAddress()
    ).toLowerCase();

  if (
    signerAddress !==
    PAYOUT_WALLET
  ) {
    throw new Error(
      "PAYOUT_PRIVATE_KEY does not match PAYOUT_WALLET"
    );
  }

  const usdtAbi = [
    "function transfer(address to, uint256 amount) returns (bool)",
    "function balanceOf(address account) view returns (uint256)"
  ];

  const usdt =
    new ethers.Contract(
      USDT_CONTRACT,
      usdtAbi,
      signer
    );

  const rawAmount =
    ethers.parseUnits(
      payoutAmount.toFixed(6),
      18
    );

  const usdtBalance =
    await usdt.balanceOf(
      signerAddress
    );

  if (usdtBalance < rawAmount) {
    throw new Error(
      "Payout wallet has insufficient USDT balance"
    );
  }

  const tx =
    await usdt.transfer(
      walletAddress,
      rawAmount
    );

  const receipt =
    await tx.wait();

  if (
    !receipt ||
    receipt.status !== 1
  ) {
    throw new Error(
      "Payout transaction failed"
    );
  }

  return {
    success: true,
    txHash: tx.hash,
    clientOid:
      String(clientOid),
    from: signerAddress,
    to: walletAddress,
    amount: payoutAmount,
    network: "BEP-20 / BSC"
  };
}

/* =========================
   READ REQUEST BODY
========================= */

function readBody(req) {
  return new Promise(
    (resolve, reject) => {
      let body = "";

      req.on(
        "data",
        (chunk) => {
          body += chunk;

          if (body.length > 10000) {
            reject(
              new Error(
                "Request body too large"
              )
            );

            req.destroy();
          }
        }
      );

      req.on(
        "end",
        () => {
          try {
            resolve(
              body
                ? JSON.parse(body)
                : {}
            );
          } catch (e) {
            reject(
              new Error(
                "Invalid JSON"
              )
            );
          }
        }
      );

      req.on(
        "error",
        reject
      );
    }
  );
}

/* =========================
   HTTP SERVER
========================= */

const server =
  http.createServer(
    async (req, res) => {

      const parsed =
        new URL(
          req.url,
          `http://${req.headers.host}`
        );

      /* =========================
         HOME
      ========================= */

      if (
        req.method === "GET" &&
        parsed.pathname === "/"
      ) {
        res.writeHead(
          200,
          {
            "Content-Type":
              "text/plain"
          }
        );

        return res.end(
          "Telegram Bot Backend is running!"
        );
      }

      /* =========================
         DATABASE TASK LIST
      ========================= */

      if (
        req.method === "GET" &&
        parsed.pathname === "/tasks"
      ) {
        try {
          const tasks =
            await getTasks();

          res.writeHead(
            200,
            {
              "Content-Type":
                "application/json"
            }
          );

          return res.end(
            JSON.stringify({
              success: true,
              tasks
            })
          );
        } catch (error) {
          console.error(
            "Get tasks error:",
            error.message
          );

          res.writeHead(
            500,
            {
              "Content-Type":
                "application/json"
            }
          );

          return res.end(
            JSON.stringify({
              success: false,
              error:
                error.message
            })
          );
        }
      }

      /* =========================
         GET SINGLE TASK
      ========================= */

      if (
        req.method === "GET" &&
        parsed.pathname === "/task"
      ) {
        const taskId =
          parsed.searchParams.get(
            "task_id"
          );

        if (!taskId) {
          res.writeHead(
            400,
            {
              "Content-Type":
                "application/json"
            }
          );

          return res.end(
            JSON.stringify({
              success: false,
              error:
                "task_id is required"
            })
          );
        }

        try {
          const task =
            await getTask(taskId);

          res.writeHead(
            200,
            {
              "Content-Type":
                "application/json"
            }
          );

          return res.end(
            JSON.stringify({
              success: true,
              task
            })
          );
        } catch (error) {
          res.writeHead(
            500,
            {
              "Content-Type":
                "application/json"
            }
          );

          return res.end(
            JSON.stringify({
              success: false,
              error:
                error.message
            })
          );
        }
      }

      /* =========================
         ADD TASK
      ========================= */

      if (
        req.method === "POST" &&
        parsed.pathname === "/task"
      ) {
        try {
          const body =
            await readBody(req);

          const taskId =
            Number(body.task_id);

          const title =
            String(
              body.title || ""
            ).trim();

          const description =
            String(
              body.description || ""
            ).trim();

          const link =
            String(
              body.link || ""
            ).trim();

          const reward =
            Number(body.reward);

          const status =
            String(
              body.status ||
              "active"
            ).trim();

          const verificationType =
            String(
              body.verification_type ||
              "manual"
            ).trim();

          const verificationTarget =
            String(
              body.verification_target ||
              ""
            ).trim();

          if (
            !Number.isInteger(taskId) ||
            taskId <= 0
          ) {
            throw new Error(
              "Valid task_id is required"
            );
          }

          if (!title) {
            throw new Error(
              "Task title is required"
            );
          }

          if (
            !Number.isFinite(reward) ||
            reward < 0
          ) {
            throw new Error(
              "Valid reward is required"
            );
          }

          const existing =
            await getTask(taskId);

          if (existing) {
            res.writeHead(
              409,
              {
                "Content-Type":
                  "application/json"
              }
            );

            return res.end(
              JSON.stringify({
                success: false,
                error:
                  "Task ID already exists"
              })
            );
          }

          const task =
            await addTask(
              taskId,
              title,
              description,
              link,
              reward,
              status,
              verificationType,
              verificationTarget
            );

          res.writeHead(
            201,
            {
              "Content-Type":
                "application/json"
              }
            );

          return res.end(
            JSON.stringify({
              success: true,
              task
            })
          );
        } catch (error) {
          console.error(
            "Add task error:",
            error.message
          );

          res.writeHead(
            400,
            {
              "Content-Type":
                "application/json"
            }
          );

          return res.end(
            JSON.stringify({
              success: false,
              error:
                error.message
            })
          );
        }
      }

      /* =========================
         UPDATE TASK
      ========================= */

      if (
        req.method === "PUT" &&
        parsed.pathname === "/task"
      ) {
        try {
          const body =
            await readBody(req);

          const taskId =
            Number(body.task_id);

          const title =
            String(
              body.title || ""
            ).trim();

          const description =
            String(
              body.description || ""
            ).trim();

          const link =
            String(
              body.link || ""
            ).trim();

          const reward =
            Number(body.reward);

          const status =
            String(
              body.status ||
              "active"
            ).trim();

          const verificationType =
            String(
              body.verification_type ||
              "manual"
            ).trim();

          const verificationTarget =
            String(
              body.verification_target ||
              ""
            ).trim();

          if (
            !Number.isInteger(taskId) ||
            taskId <= 0
          ) {
            throw new Error(
              "Valid task_id is required"
            );
          }

          if (!title) {
            throw new Error(
              "Task title is required"
            );
          }

          if (
            !Number.isFinite(reward) ||
            reward < 0
          ) {
            throw new Error(
              "Valid reward is required"
            );
          }

          const task =
            await updateTask(
              taskId,
              title,
              description,
              link,
              reward,
              status,
              verificationType,
              verificationTarget
            );

          if (!task) {
            res.writeHead(
              404,
              {
                "Content-Type":
                  "application/json"
              }
            );

            return res.end(
              JSON.stringify({
                success: false,
                error:
                  "Task not found"
              })
            );
          }

          res.writeHead(
            200,
            {
              "Content-Type":
                "application/json"
            }
          );

          return res.end(
            JSON.stringify({
              success: true,
              task
            })
          );
        } catch (error) {
          res.writeHead(
            400,
            {
              "Content-Type":
                "application/json"
            }
          );

          return res.end(
            JSON.stringify({
              success: false,
              error:
                error.message
            })
          );
        }
      }

      /* =========================
         DELETE TASK
      ========================= */

      if (
        req.method === "DELETE" &&
        parsed.pathname === "/task"
      ) {
        const taskId =
          parsed.searchParams.get(
            "task_id"
          );

        if (!taskId) {
          res.writeHead(
            400,
            {
              "Content-Type":
                "application/json"
              }
            );

          return res.end(
            JSON.stringify({
              success: false,
              error:
                "task_id is required"
            })
          );
        }

        try {
          const task =
            await deleteTask(
              taskId
            );

          if (!task) {
            res.writeHead(
              404,
              {
                "Content-Type":
                  "application/json"
              }
            );

            return res.end(
              JSON.stringify({
                success: false,
                error:
                  "Task not found"
              })
            );
          }

          res.writeHead(
            200,
            {
              "Content-Type":
                "application/json"
            }
          );

          return res.end(
            JSON.stringify({
              success: true,
              deleted: task
            })
          );
        } catch (error) {
          res.writeHead(
            500,
            {
              "Content-Type":
                "application/json"
              }
            );

          return res.end(
            JSON.stringify({
              success: false,
              error:
                error.message
            })
          );
        }
      }

      /* =========================
         YOUTUBE OAUTH START
         GET /youtube/auth
         ?user_id=123
      ========================= */

      if (
        req.method === "GET" &&
        parsed.pathname === "/youtube/auth"
      ) {
        try {
          if (!youtubeConfigured()) {
            res.writeHead(
              500,
              {
                "Content-Type":
                  "application/json"
              }
            );

            return res.end(
              JSON.stringify({
                success: false,
                error:
                  "YouTube OAuth is not fully configured. Set YOUTUBE_REDIRECT_URI too."
              })
            );
          }

          const userId =
            String(
              parsed.searchParams.get(
                "user_id"
              ) || ""
            ).trim();

          if (!userId) {
            res.writeHead(
              400,
              {
                "Content-Type":
                  "application/json"
              }
            );

            return res.end(
              JSON.stringify({
                success: false,
                error:
                  "user_id is required"
              })
            );
          }

          const oauthClient =
            createYoutubeOAuthClient();

          const state =
            Buffer.from(
              JSON.stringify({
                userId,
                secret:
                  YOUTUBE_OAUTH_SECRET,
                createdAt:
                  Date.now()
              })
            ).toString("base64url");

          const authUrl =
            oauthClient.generateAuthUrl({
              access_type: "offline",
              prompt: "consent",
              scope:
                YOUTUBE_SCOPES,
              state
            });

          res.writeHead(
            302,
            {
              Location:
                authUrl
            }
          );

          return res.end();

        } catch (error) {
          console.error(
            "YouTube auth error:",
            error.message
          );

          res.writeHead(
            500,
            {
              "Content-Type":
                "application/json"
            }
          );

          return res.end(
            JSON.stringify({
              success: false,
              error:
                error.message
            })
          );
        }
      }

      /* =========================
         YOUTUBE OAUTH CALLBACK
         GET /youtube/callback
      ========================= */

      if (
        req.method === "GET" &&
        parsed.pathname ===
          "/youtube/callback"
      ) {
        try {
          const code =
            String(
              parsed.searchParams.get(
                "code"
              ) || ""
            ).trim();

          const state =
            String(
              parsed.searchParams.get(
                "state"
              ) || ""
            ).trim();

          const oauthError =
            String(
              parsed.searchParams.get(
                "error"
              ) || ""
            ).trim();

          if (oauthError) {
            res.writeHead(
              400,
              {
                "Content-Type":
                  "text/html; charset=utf-8"
              }
            );

            return res.end(
              "<h2>YouTube authorization was cancelled.</h2><p>You can close this page and return to Telegram.</p>"
            );
          }

          if (!code || !state) {
            res.writeHead(
              400,
              {
                "Content-Type":
                  "text/html; charset=utf-8"
              }
            );

            return res.end(
              "<h2>Invalid YouTube authorization response.</h2>"
            );
          }

          let stateData;

          try {
            stateData =
              JSON.parse(
                Buffer.from(
                  state,
                  "base64url"
                ).toString(
                  "utf8"
                )
              );
          } catch (e) {
            throw new Error(
              "Invalid OAuth state"
            );
          }

          if (
            stateData.secret !==
            YOUTUBE_OAUTH_SECRET
          ) {
            res.writeHead(
              403,
              {
                "Content-Type":
                  "text/html; charset=utf-8"
              }
            );

            return res.end(
              "<h2>Invalid OAuth state.</h2>"
            );
          }

          const oauthClient =
            createYoutubeOAuthClient();

          const tokenResponse =
            await oauthClient.getToken(
              code
            );

          const tokens =
            tokenResponse.tokens || {};

                    if (!tokens.refresh_token) {
            console.warn(
              "No refresh token returned for YouTube user:",
              stateData.userId
            );
                    }          const userId =
            String(
              stateData.userId || ""
            ).trim();

          if (!userId) {
            throw new Error(
              "OAuth user ID is missing"
            );
          }

          await saveYoutubeTokens(
            userId,
            tokens
          );

          res.writeHead(
            200,
            {
              "Content-Type":
                "text/html; charset=utf-8"
            }
          );

          return res.end(
            "<h2>YouTube account connected successfully.</h2>" +
            "<p>You can close this page and return to Telegram.</p>"
          );

        } catch (error) {
          console.error(
            "YouTube callback error:",
            error.message
          );

          res.writeHead(
            500,
            {
              "Content-Type":
                "text/html; charset=utf-8"
            }
          );

          return res.end(
            "<h2>YouTube connection failed.</h2>" +
            "<p>" +
            String(error.message) +
            "</p>"
          );
        }
      }

      /* =========================
         YOUTUBE STATUS
         GET /youtube/status
         ?user_id=123
      ========================= */

      if (
        req.method === "GET" &&
        parsed.pathname ===
          "/youtube/status"
      ) {
        try {
          const userId =
            String(
              parsed.searchParams.get(
                "user_id"
              ) || ""
            ).trim();

          if (!userId) {
            return sendJson(
              res,
              400,
              {
                success: false,
                error:
                  "user_id is required"
              }
            );
          }

          const tokens =
            await getYoutubeTokens(
              userId
            );

          if (!tokens) {
            return sendJson(
              res,
              200,
              {
                success: true,
                connected: false
              }
            );
          }

          return sendJson(
            res,
            200,
            {
              success: true,
              connected: true
            }
          );

        } catch (error) {
          console.error(
            "YouTube status error:",
            error.message
          );

          return sendJson(
            res,
            500,
            {
              success: false,
              error:
                error.message
            }
          );
        }
      }
            /* =========================
         PAYMENT VERIFICATION
      ========================= */

      if (
        req.method === "POST" &&
        parsed.pathname ===
          "/verify-payment"
      ) {
        try {
          const body =
            await readBody(req);

          const txHash =
            String(
              body.txHash ||
              body.txid ||
              body.transaction_hash ||
              ""
            ).trim();

          const expectedAmount =
            Number(
              body.amount ||
              body.plan_price ||
              PLAN_PRICE
            );

          if (!txHash) {
            return sendJson(
              res,
              400,
              {
                success: false,
                verified: false,
                error:
                  "Transaction hash is required"
              }
            );
          }

          if (
            !/^0x[a-fA-F0-9]{64}$/.test(
              txHash
            )
          ) {
            return sendJson(
              res,
              400,
              {
                success: false,
                verified: false,
                error:
                  "Invalid transaction hash"
              }
            );
          }

          if (
            !Number.isFinite(
              expectedAmount
            ) ||
            expectedAmount <= 0
          ) {
            return sendJson(
              res,
              400,
              {
                success: false,
                verified: false,
                error:
                  "Invalid payment amount"
              }
            );
          }

          const result =
            await verifyPayment(
              txHash,
              expectedAmount
            );

          return sendJson(
            res,
            200,
            result
          );

        } catch (error) {
          console.error(
            "Payment verification error:",
            error.message
          );

          return sendJson(
            res,
            500,
            {
              success: false,
              verified: false,
              error:
                error.message
            }
          );
        }
      }

      /* =========================
         PAYOUT
      ========================= */

      if (
        req.method === "POST" &&
        parsed.pathname ===
          "/payout"
      ) {
        try {
          const secret =
            String(
              req.headers[
                "x-api-secret"
              ] || ""
            ).trim();

          if (
            !PAYOUT_API_SECRET ||
            secret !==
              PAYOUT_API_SECRET
          ) {
            return sendJson(
              res,
              401,
              {
                success: false,
                error:
                  "Unauthorized"
              }
            );
          }

          const body =
            await readBody(req);

          const walletAddress =
            String(
              body.wallet ||
              body.address ||
              body.walletAddress ||
              ""
            ).trim();

          const amount =
            Number(
              body.amount
            );

          const clientOid =
            String(
              body.clientOid ||
              body.client_oid ||
              ""
            ).trim();

          if (!walletAddress) {
            return sendJson(
              res,
              400,
              {
                success: false,
                error:
                  "Wallet address is required"
              }
            );
          }

          if (
            !Number.isFinite(amount) ||
            amount <= 0
          ) {
            return sendJson(
              res,
              400,
              {
                success: false,
                error:
                  "Valid payout amount is required"
              }
            );
          }

          const payout =
            await sendPayout(
              walletAddress,
              amount,
              clientOid ||
                "WD_" +
                Date.now()
            );

          return sendJson(
            res,
            200,
            payout
          );

        } catch (error) {
          console.error(
            "Payout error:",
            error.message
          );

          return sendJson(
            res,
            500,
            {
              success: false,
              error:
                error.message
            }
          );
        }
      }

      /* =========================
         404
      ========================= */

      return sendJson(
        res,
        404,
        {
          success: false,
          error:
            "Route not found"
        }
      );
    }
  );

/* =========================
   SERVER START
========================= */

server.listen(
  PORT,
  () => {
    console.log(
      "Telegram Bot Backend is running!"
    );

    console.log(
      "Port:",
      PORT
    );

    console.log(
      "Database:",
      DATABASE_URL
        ? "configured"
        : "missing"
    );

    console.log(
      "YouTube OAuth:",
      youtubeConfigured()
        ? "configured"
        : "not configured"
    );

    console.log(
      "Telegram Bot Token:",
      TELEGRAM_BOT_TOKEN
        ? "configured"
        : "missing"
    );

    console.log(
      "Payment Wallet:",
      PAYMENT_WALLET
    );

    console.log(
      "Payout Wallet:",
      PAYOUT_WALLET
        ? PAYOUT_WALLET
        : "missing"
    );
  }
);
