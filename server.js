const http = require("http");
const https = require("https");
const { ethers } = require("ethers");
const { Pool } = require("pg");
const { google } = require("googleapis");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;

const RPC_URL =
  "https://bsc-dataseed.bnbchain.org";


/* =========================
   PAYMENT SETTINGS
========================= */

const PAYMENT_WALLET =
  "0x07207Bf282B4e3dc2db376F29e40bfbc7d61607B"
    .toLowerCase();

const USDT_CONTRACT =
  "0x55d398326f99059ff775485246999027b3197955"
    .toLowerCase();

const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";


/* =========================
   PAYOUT SETTINGS
========================= */

const PAYOUT_WALLET =
  String(
    process.env.PAYOUT_WALLET || ""
  )
    .trim()
    .toLowerCase();

const PAYOUT_PRIVATE_KEY =
  String(
    process.env.PAYOUT_PRIVATE_KEY || ""
  ).trim();

const PAYOUT_API_SECRET =
  String(
    process.env.PAYOUT_API_SECRET || ""
  ).trim();


/* =========================
   YOUTUBE OAUTH SETTINGS
========================= */

const YOUTUBE_CLIENT_ID =
  String(
    process.env.YOUTUBE_CLIENT_ID || ""
  ).trim();

const YOUTUBE_CLIENT_SECRET =
  String(
    process.env.YOUTUBE_CLIENT_SECRET || ""
  ).trim();

const YOUTUBE_REDIRECT_URI =
  String(
    process.env.YOUTUBE_REDIRECT_URI ||
      "https://telegram-bot-backend-production-c04c.up.railway.app/youtube/callback"
  ).trim();


const YOUTUBE_SCOPES = [
  "https://www.googleapis.com/auth/youtube.readonly"
];


/* =========================
   MINIMUM WITHDRAW
========================= */

let MIN_WITHDRAW =
  Number(
    process.env.MIN_WITHDRAW || 0.15
  );

if (
  !Number.isFinite(MIN_WITHDRAW) ||
  MIN_WITHDRAW <= 0
) {
  MIN_WITHDRAW = 0.15;
}


/* =========================
   PAYOUT LOCK
========================= */

let payoutBusy = false;

const processedPayouts =
  new Set();


/* =========================
   POSTGRESQL
========================= */

const db =
  new Pool({
    connectionString:
      process.env.DATABASE_URL,

    ssl: {
      rejectUnauthorized: false
    }
  });


/* =========================================================
   DATABASE INITIALIZATION
========================================================= */

async function initDatabase() {

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


  await db.query(`
    CREATE TABLE IF NOT EXISTS youtube_accounts (
      user_id TEXT PRIMARY KEY,

      refresh_token TEXT NOT NULL,

      access_token TEXT,

      expiry_date BIGINT,

      created_at TIMESTAMPTZ DEFAULT NOW(),

      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);


  await db.query(`
    CREATE TABLE IF NOT EXISTS youtube_oauth_states (
      state TEXT PRIMARY KEY,

      user_id TEXT NOT NULL,

      expires_at TIMESTAMPTZ NOT NULL
    )
  `);


  await db.query(`
    ALTER TABLE "Task Plan Bot"
    ADD COLUMN IF NOT EXISTS verification_type TEXT DEFAULT 'manual'
  `);


  await db.query(`
    ALTER TABLE "Task Plan Bot"
    ADD COLUMN IF NOT EXISTS verification_target TEXT DEFAULT ''
  `);


  console.log(
    "PostgreSQL connected and tables ready"
  );
}


/* =========================================================
   TASK FUNCTIONS
========================================================= */

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

        COALESCE(
          verification_type,
          'manual'
        ) AS verification_type,

        COALESCE(
          verification_target,
          ''
        ) AS verification_target

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

        COALESCE(
          verification_type,
          'manual'
        ) AS verification_type,

        COALESCE(
          verification_target,
          ''
        ) AS verification_target

      FROM "Task Plan Bot"

      WHERE task_id = $1

      LIMIT 1
      `,
      [
        Number(taskId)
      ]
    );

  return result.rows[0] || null;
}


async function addTask(body) {

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
      (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8
      )

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
        Number(body.task_id),

        String(
          body.title || ""
        ),

        String(
          body.description || ""
        ),

        String(
          body.link || ""
        ),

        Number(
          body.reward || 0.05
        ),

        String(
          body.status || "active"
        ),

        String(
          body.verification_type ||
            "manual"
        ),

        String(
          body.verification_target ||
            ""
        )
      ]
    );

  return result.rows[0];
}


async function updateTask(body) {

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
        Number(body.task_id),

        String(
          body.title || ""
        ),

        String(
          body.description || ""
        ),

        String(
          body.link || ""
        ),

        Number(
          body.reward || 0.05
        ),

        String(
          body.status || "active"
        ),

        String(
          body.verification_type ||
            "manual"
        ),

        String(
          body.verification_target ||
            ""
        )
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

      RETURNING *
      `,
      [
        Number(taskId)
      ]
    );

  return result.rows[0] || null;
}


/* =========================================================
   REQUEST BODY
========================================================= */

async function readBody(req) {

  return new Promise(
    (resolve, reject) => {

      let body = "";

      req.on(
        "data",
        (chunk) => {

          body += chunk;

          if (
            body.length > 20000
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

          try {

            resolve(
              body
                ? JSON.parse(body)
                : {}
            );

          } catch (error) {

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


/* =========================================================
   RESPONSE
========================================================= */

function send(
  res,
  status,
  data,
  type = "application/json"
) {

  res.writeHead(
    status,
    {
      "Content-Type":
        type
    }
  );


  if (
    type.includes("json")
  ) {

    return res.end(
      JSON.stringify(data)
    );
  }


  return res.end(
    data
  );
}


/* =========================================================
   YOUTUBE CONFIG
========================================================= */

function youtubeConfigured() {

  return !!(
    YOUTUBE_CLIENT_ID &&
    YOUTUBE_CLIENT_SECRET &&
    YOUTUBE_REDIRECT_URI
  );
}


function youtubeClient() {

  if (
    !youtubeConfigured()
  ) {

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


/* =========================================================
   YOUTUBE CHANNEL TARGET
========================================================= */

function extractYoutubeTarget(value) {

  let text =
    String(
      value || ""
    ).trim();


  if (!text) {

    return {
      type: "",
      value: ""
    };
  }


  if (
    /^UC[a-zA-Z0-9_-]{20,}$/.test(
      text
    )
  ) {

    return {
      type: "channelId",
      value: text
    };
  }


  const channelMatch =
    text.match(
      /youtube\.com\/channel\/(UC[a-zA-Z0-9_-]+)/i
    );

  if (
    channelMatch
  ) {

    return {
      type: "channelId",
      value: channelMatch[1]
    };
  }


  const handleMatch =
    text.match(
      /(?:youtube\.com\/)?@([a-zA-Z0-9._-]+)/i
    );

  if (
    handleMatch
  ) {

    return {
      type: "handle",
      value:
        "@" +
        handleMatch[1]
    };
  }


  return {
    type: "",
    value: ""
  };
}


/* =========================================================
   RESOLVE YOUTUBE CHANNEL ID
========================================================= */

async function resolveYoutubeChannelId(
  oauth,
  target
) {

  const parsed =
    extractYoutubeTarget(
      target
    );


  if (
    !parsed.type
  ) {

    throw new Error(
      "Invalid YouTube verification target. Use a YouTube channel ID, channel URL, or @handle."
    );
  }


  if (
    parsed.type === "channelId"
  ) {

    return parsed.value;
  }


  if (
    parsed.type === "handle"
  ) {

    const youtube =
      google.youtube({
        version: "v3",
        auth: oauth
      });


    const response =
      await youtube.channels.list({

        part: [
          "id"
        ],

        forHandle:
          parsed.value,

        maxResults:
          1
      });


    const items =
      response.data.items || [];


    if (
      !items.length ||
      !items[0].id
    ) {

      throw new Error(
        "YouTube channel could not be found for " +
        parsed.value
      );
    }


    return items[0].id;
  }


  throw new Error(
    "Could not resolve YouTube channel"
  );
}


/* =========================================================
   YOUTUBE VERIFY SUBSCRIPTION
========================================================= */

async function youtubeVerify(
  oauth,
  target
) {

  const targetChannelId =
    await resolveYoutubeChannelId(
      oauth,
      target
    );


  const youtube =
    google.youtube({
      version: "v3",
      auth: oauth
    });


  const response =
    await youtube.subscriptions.list({

      part: [
        "snippet"
      ],

      mine:
        true,

      forChannelId:
        targetChannelId,

      maxResults:
        1
    });


  const items =
    response.data.items || [];


  return {

    verified:
      items.length > 0,

    channelId:
      targetChannelId
  };
}


/* =========================================================
   SAVE YOUTUBE TOKEN
========================================================= */

async function saveYoutubeToken(
  userId,
  tokens
) {

  let refreshToken =
    tokens.refresh_token ||
    "";


  if (
    !refreshToken
  ) {

    const old =
      await db.query(
        `
        SELECT refresh_token
        FROM youtube_accounts

        WHERE user_id = $1
        `,
        [
          String(userId)
        ]
      );


    if (
      old.rows[0]
    ) {

      refreshToken =
        old.rows[0].refresh_token;
    }
  }


  if (
    !refreshToken
  ) {

    throw new Error(
      "No refresh token received from YouTube"
    );
  }


  await db.query(
    `
    INSERT INTO youtube_accounts
    (
      user_id,
      refresh_token,
      access_token,
      expiry_date,
      updated_at
    )

    VALUES
    (
      $1,
      $2,
      $3,
      $4,
      NOW()
    )

    ON CONFLICT(user_id)

    DO UPDATE SET
      refresh_token = $2,
      access_token = $3,
      expiry_date = $4,
      updated_at = NOW()
    `,
    [
      String(userId),

      refreshToken,

      tokens.access_token ||
        "",

      tokens.expiry_date ||
        0
    ]
  );
}


/* =========================================================
   GET YOUTUBE OAUTH FOR USER
========================================================= */

async function getYoutubeOAuthForUser(
  userId
) {

  const result =
    await db.query(
      `
      SELECT *
      FROM youtube_accounts

      WHERE user_id = $1

      LIMIT 1
      `,
      [
        String(userId)
      ]
    );


  if (
    !result.rows[0]
  ) {

    return null;
  }


  const row =
    result.rows[0];


  const client =
    youtubeClient();


  client.setCredentials({

    refresh_token:
      row.refresh_token,

    access_token:
      row.access_token ||
      undefined,

    expiry_date:
      Number(
        row.expiry_date
      ) ||
      undefined
  });


  return client;
}


/* =========================================================
   RPC REQUEST
========================================================= */

function rpcRequest(
  method,
  params,
  callback
) {

  const body =
    JSON.stringify({

      jsonrpc:
        "2.0",

      id:
        1,

      method:
        method,

      params:
        params
    });


  const url =
    new URL(
      RPC_URL
    );


  const req =
    https.request(
      {

        hostname:
          url.hostname,

        path:
          url.pathname,

        method:
          "POST",

        headers: {

          "Content-Type":
            "application/json",

          "Content-Length":
            Buffer.byteLength(
              body
            )
        }
      },


      (res) => {

        let data = "";


        res.on(
          "data",
          (chunk) => {

            data += chunk;
          }
        );


        res.on(
          "end",
          () => {

            try {

              const json =
                JSON.parse(
                  data
                );


              if (
                json.error
              ) {

                return callback({

                  error:
                    json.error.message ||
                    "RPC error"
                });
              }


              callback(
                null,
                json.result
              );

            } catch (error) {

              callback({

                error:
                  "Invalid RPC response"
              });
            }
          }
        );
      }
    );


  req.on(
    "error",
    () => {

      callback({

        error:
          "BSC RPC connection failed"
      });
    }
  );


  req.write(body);
  req.end();
}


/* =========================================================
   PAYMENT VERIFICATION
========================================================= */

function verifyPayment(
  txHash,
  callback
) {

  if (
    !/^0x[a-fA-F0-9]{64}$/.test(
      txHash
    )
  ) {

    return callback({

      verified:
        false,

      error:
        "Invalid TXID"
    });
  }


  rpcRequest(
    "eth_getTransactionByHash",
    [txHash],

    (error, tx) => {

      if (
        error
      ) {

        return callback({

          verified:
            false,

          error:
            error.error ||
            "RPC error"
        });
      }


      if (!tx) {

        return callback({

          verified:
            false,

          reason:
            "Transaction not found"
        });
      }


      if (
        String(
          tx.to || ""
        ).toLowerCase() !==
        USDT_CONTRACT
      ) {

        return callback({

          verified:
            false,

          reason:
            "Transaction is not a USDT contract transaction"
        });
      }


      rpcRequest(
        "eth_getTransactionReceipt",
        [txHash],

        (
          receiptError,
          receipt
        ) => {

          if (
            receiptError
          ) {

            return callback({

              verified:
                false,

              error:
                receiptError.error ||
                "Could not get transaction receipt"
            });
          }


          if (
            !receipt
          ) {

            return callback({

              verified:
                false,

              reason:
                "Transaction is still pending",

              confirmations:
                0
            });
          }


          if (
            String(
              receipt.status
            ).toLowerCase() !==
            "0x1"
          ) {

            return callback({

              verified:
                false,

              reason:
                "Transaction failed"
            });
          }


          let payment =
            null;


          for (
            const log of
            (
              receipt.logs ||
              []
            )
          ) {

            if (
              String(
                log.address || ""
              ).toLowerCase() !==
              USDT_CONTRACT
            ) {

              continue;
            }


            if (
              !log.topics ||
              log.topics.length < 3
            ) {

              continue;
            }


            if (
              String(
                log.topics[0]
              ).toLowerCase() !==
              TRANSFER_TOPIC
            ) {

              continue;
            }


            const from =
              "0x" +
              String(
                log.topics[1]
              )
                .slice(-40)
                .toLowerCase();


            const to =
              "0x" +
              String(
                log.topics[2]
              )
                .slice(-40)
                .toLowerCase();


            if (
              to !==
              PAYMENT_WALLET
            ) {

              continue;
            }


            try {

              const raw =
                BigInt(
                  String(
                    log.data ||
                    "0x0"
                  )
                );


              const amount =
                Number(raw) /
                1e18;


              if (
                Number.isFinite(
                  amount
                ) &&
                amount > 0
              ) {

                payment = {

                  from:
                    from,

                  to:
                    to,

                  amount:
                    amount,

                  rawValue:
                    raw.toString(),

                  blockNumber:
                    receipt.blockNumber
                };


                break;
              }

            } catch (error) {}
          }


          if (
            !payment
          ) {

            return callback({

              verified:
                false,

              reason:
                "No BEP-20 USDT Transfer to the payment wallet was found"
            });
          }


          rpcRequest(
            "eth_blockNumber",
            [],

            (
              blockError,
              latestBlock
            ) => {

              if (
                blockError
              ) {

                return callback({

                  verified:
                    false,

                  error:
                    blockError.error ||
                    "Could not get latest BSC block"
                });
              }


              let confirmations =
                0;


              try {

                confirmations =
                  Number(
                    BigInt(
                      latestBlock
                    ) -
                    BigInt(
                      receipt.blockNumber
                    ) +
                    1n
                  );

              } catch (error) {

                confirmations =
                  0;
              }


              if (
                confirmations < 3
              ) {

                return callback({

                  verified:
                    false,

                  reason:
                    "Transaction confirmation কম",

                  confirmations:
                    confirmations,

                  required:
                    3,

                  txHash:
                    txHash
                });
              }


              callback({

                verified:
                  true,

                txHash:
                  txHash,

                amount:
                  payment.amount,

                rawValue:
                  payment.rawValue,

                from:
                  payment.from,

                to:
                  payment.to,

                blockNumber:
                  payment.blockNumber,

                confirmations:
                  confirmations,

                requiredConfirmations:
                  3
              });
            }
          );
        }
      );
    }
  );
}


/* =========================================================
   PAYOUT
========================================================= */

async function sendPayout(
  walletAddress,
  amount,
  clientOid
) {

  if (
    !PAYOUT_PRIVATE_KEY
  ) {

    throw new Error(
      "PAYOUT_PRIVATE_KEY is missing"
    );
  }


  if (
    !PAYOUT_WALLET
  ) {

    throw new Error(
      "PAYOUT_WALLET is missing"
    );
  }


  if (
    !PAYOUT_API_SECRET
  ) {

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
    !Number.isFinite(
      payoutAmount
    ) ||
    payoutAmount <= 0
  ) {

    throw new Error(
      "Invalid payout amount"
    );
  }


  if (
    payoutAmount <
    MIN_WITHDRAW
  ) {

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


  const usdt =
    new ethers.Contract(

      USDT_CONTRACT,

      [
        "function transfer(address to,uint256 amount) returns (bool)",

        "function balanceOf(address account) view returns (uint256)"
      ],

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


  if (
    usdtBalance <
    rawAmount
  ) {

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

    success:
      true,

    txHash:
      tx.hash,

    clientOid:
      String(clientOid),

    from:
      signerAddress,

    to:
      walletAddress,

    amount:
      payoutAmount,

    network:
      "BEP-20 / BSC"
  };
}


/* =========================================================
   YOUTUBE OAUTH STATE
========================================================= */

function createOAuthState(
  userId
) {

  const state =
    crypto
      .randomBytes(32)
      .toString("hex");


  return db.query(
    `
    INSERT INTO youtube_oauth_states
    (
      state,
      user_id,
      expires_at
    )

    VALUES
    (
      $1,
      $2,
      NOW() + INTERVAL '10 minutes'
    )
    `,
    [
      state,
      String(userId)
    ]
  ).then(
    () => state
  );
}


/* =========================================================
   CLEAN OAUTH STATES
========================================================= */

async function cleanOAuthStates() {

  await db.query(`
    DELETE FROM youtube_oauth_states
    WHERE expires_at < NOW()
  `);
}


/* =========================================================
   YOUTUBE AUTH URL
========================================================= */

async function getYoutubeAuthUrl(
  userId
) {

  if (
    !youtubeConfigured()
  ) {

    throw new Error(
      "YouTube OAuth is not configured"
    );
  }


  await cleanOAuthStates();


  const state =
    await createOAuthState(
      userId
    );


  const oauth =
    youtubeClient();


  return oauth.generateAuthUrl({

    access_type:
      "offline",

    prompt:
      "consent",

    scope:
      YOUTUBE_SCOPES,

    state:
      state
  });
}


/* =========================================================
   OAUTH STATE CHECK
========================================================= */

async function getOAuthState(
  state
) {

  const result =
    await db.query(
      `
      SELECT
        state,
        user_id

      FROM youtube_oauth_states

      WHERE state = $1

      AND expires_at > NOW()

      LIMIT 1
      `,
      [
        String(state)
      ]
    );


  return result.rows[0] || null;
}


/* =========================================================
   DELETE OAUTH STATE
========================================================= */

async function deleteOAuthState(
  state
) {

  await db.query(
    `
    DELETE FROM youtube_oauth_states
    WHERE state = $1
    `,
    [
      String(state)
    ]
  );
}


/* =========================================================
   TASK COMPLETION CHECK
========================================================= */

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


  return (
    result.rows.length > 0
  );
}


/* =========================================================
   SAVE TASK COMPLETION
========================================================= */

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
      (
        $1,
        $2,
        $3,
        $4
      )

      ON CONFLICT
      (
        user_id,
        task_id
      )

      DO NOTHING

      RETURNING *
      `,
      [
        String(userId),

        Number(taskId),

        Number(
          reward || 0
        ),

        String(
          verificationType ||
          "manual"
        )
      ]
    );


  return result.rows[0] || null;
}


/* =========================================================
   YOUTUBE VERIFY TASK
========================================================= */

async function verifyYoutubeTask(
  userId,
  taskId
) {

  const task =
    await getTask(
      taskId
    );


  if (!task) {

    return {

      success:
        false,

      verified:
        false,

      error:
        "Task not found"
    };
  }


  if (
    String(
      task.status
    ).toLowerCase() !==
    "active"
  ) {

    return {

      success:
        false,

      verified:
        false,

      error:
        "Task is not active"
    };
  }


  const type =
    String(
      task.verification_type ||
      "manual"
    ).toLowerCase();


  if (
    type !==
      "youtube_subscribe" &&
    type !==
      "youtube"
  ) {

    return {

      success:
        false,

      verified:
        false,

      error:
        "This task is not a YouTube Subscribe task"
    };
  }


  const already =
    await taskAlreadyCompleted(
      userId,
      task.task_id
    );


  if (already) {

    return {

      success:
        true,

      verified:
        true,

      alreadyCompleted:
        true,

      taskId:
        task.task_id,

      reward:
        Number(
          task.reward || 0
        )
    };
  }


  const oauth =
    await getYoutubeOAuthForUser(
      userId
    );


  if (!oauth) {

    return {

      success:
        false,

      verified:
        false,

      connected:
        false,

      error:
        "YouTube account is not connected"
    };
  }


  const target =
    String(
      task.verification_target ||
      task.link ||
      ""
    ).trim();


  if (!target) {

    return {

      success:
        false,

      verified:
        false,

      connected:
        true,

      error:
        "YouTube verification target is missing"
    };
  }


  const check =
    await youtubeVerify(
      oauth,
      target
    );


  if (
    !check.verified
  ) {

    return {

      success:
        true,

      verified:
        false,

      connected:
        true,

      taskId:
        task.task_id,

      reward:
        Number(
          task.reward || 0
        ),

      channelId:
        check.channelId,

      message:
        "YouTube channel subscription not found"
    };
  }


  const completion =
    await saveTaskCompletion(

      userId,

      task.task_id,

      Number(
        task.reward || 0
      ),

      type
    );


  if (!completion) {

    return {

      success:
        true,

      verified:
        true,

      alreadyCompleted:
        true,

      taskId:
        task.task_id,

      reward:
        Number(
          task.reward || 0
        )
    };
  }


  return {

    success:
      true,

    verified:
      true,

    alreadyCompleted:
      false,

    taskId:
      task.task_id,

    reward:
      Number(
        task.reward || 0
      ),

    channelId:
      check.channelId
  };
}


/* =========================================================
   HTTP SERVER
========================================================= */

const server =
  http.createServer(
    async (req, res) => {

      let parsed;


      try {

        parsed =
          new URL(
            req.url,
            `http://${req.headers.host}`
          );

      } catch (error) {

        return send(
          res,
          400,
          {

            success:
              false,

            error:
              "Invalid URL"
          }
        );
      }


      /* =====================================================
         HOME
      ===================================================== */

      if (
        req.method === "GET" &&
        parsed.pathname === "/"
      ) {

        return send(

          res,

          200,

          "Telegram Bot Backend is running!",

          "text/plain"
        );
      }


      /* =====================================================
         HEALTH
      ===================================================== */

      if (
        req.method === "GET" &&
        parsed.pathname === "/health"
      ) {

        return send(
          res,
          200,
          {

            success:
              true,

            status:
              "ok"
          }
        );
      }


      /* =====================================================
         GET TASKS
      ===================================================== */

      if (
        req.method === "GET" &&
        parsed.pathname === "/tasks"
      ) {

        try {

          const tasks =
            await getTasks();


          return send(
            res,
            200,
            {

              success:
                true,

              tasks:
                tasks
            }
          );

        } catch (error) {

          console.error(
            "Get tasks error:",
            error.message
          );


          return send(
            res,
            500,
            {

              success:
                false,

              error:
                error.message
            }
          );
        }
      }


      /* =====================================================
         GET SINGLE TASK
      ===================================================== */

      if (
        req.method === "GET" &&
        parsed.pathname === "/task"
      ) {

        const taskId =
          parsed.searchParams.get(
            "task_id"
          );


        if (!taskId) {

          return send(
            res,
            400,
            {

              success:
                false,

              error:
                "task_id is required"
            }
          );
        }


        try {

          const task =
            await getTask(
              taskId
            );


          return send(
            res,
            200,
            {

              success:
                true,

              task:
                task
            }
          );

        } catch (error) {

          return send(
            res,
            500,
            {

              success:
                false,

              error:
                error.message
            }
          );
        }
      }


      /* =====================================================
         ADD TASK
      ===================================================== */

      if (
        req.method === "POST" &&
        parsed.pathname === "/task"
      ) {

        try {

          const body =
            await readBody(req);


          const taskId =
            Number(
              body.task_id
            );


          if (
            !Number.isInteger(
              taskId
            ) ||
            taskId <= 0
          ) {

            throw new Error(
              "Valid task_id is required"
            );
          }


          const title =
            String(
              body.title || ""
            ).trim();


          if (!title) {

            throw new Error(
              "Task title is required"
            );
          }


          const reward =
            Number(
              body.reward
            );


          if (
            !Number.isFinite(
              reward
            ) ||
            reward < 0
          ) {

            throw new Error(
              "Valid reward is required"
            );
          }


          const existing =
            await getTask(
              taskId
            );


          if (existing) {

            return send(
              res,
              409,
              {

                success:
                  false,

                error:
                  "Task ID already exists"
              }
            );
          }


          const task =
            await addTask(
              body
            );


          return send(
            res,
            201,
            {

              success:
                true,

              task:
                task
            }
          );

        } catch (error) {

          console.error(
            "Add task error:",
            error.message
          );


          return send(
            res,
            400,
            {

              success:
                false,

              error:
                error.message
            }
          );
        }
      }


      /* =====================================================
         UPDATE TASK
      ===================================================== */

      if (
        req.method === "PUT" &&
        parsed.pathname === "/task"
      ) {

        try {

          const body =
            await readBody(req);


          const taskId =
            Number(
              body.task_id
            );


          if (
            !Number.isInteger(
              taskId
            ) ||
            taskId <= 0
          ) {

            throw new Error(
              "Valid task_id is required"
            );
          }


          const title =
            String(
              body.title || ""
            ).trim();


          if (!title) {

            throw new Error(
              "Task title is required"
            );
          }


          const reward =
            Number(
              body.reward
            );


          if (
            !Number.isFinite(
              reward
            ) ||
            reward < 0
          ) {

            throw new Error(
              "Valid reward is required"
            );
          }


          const task =
            await updateTask(
              body
            );


          if (!task) {

            return send(
              res,
              404,
              {

                success:
                  false,

                error:
                  "Task not found"
              }
            );
          }


          return send(
            res,
            200,
            {

              success:
                true,

              task:
                task
            }
          );

        } catch (error) {

          return send(
            res,
            400,
            {

              success:
                false,

              error:
                error.message
            }
          );
        }
      }


      /* =====================================================
         DELETE TASK
      ===================================================== */

      if (
        req.method === "DELETE" &&
        parsed.pathname === "/task"
      ) {

        const taskId =
          parsed.searchParams.get(
            "task_id"
          );


        if (!taskId) {

          return send(
            res,
            400,
            {

              success:
                false,

              error:
                "task_id is required"
            }
          );
        }


        try {

          const task =
            await deleteTask(
              taskId
            );


          if (!task) {

            return send(
              res,
              404,
              {

                success:
                  false,

                error:
                  "Task not found"
              }
            );
          }


          return send(
            res,
            200,
            {

              success:
                true,

              deleted:
                task
            }
          );

        } catch (error) {

          return send(
            res,
            500,
            {

              success:
                false,

              error:
                error.message
            }
          );
        }
      }


      /* =====================================================
         YOUTUBE CONNECT
         DIRECT GOOGLE REDIRECT
===================================================== */

      if (
        req.method === "GET" &&
        parsed.pathname ===
          "/youtube/connect"
      ) {

        const userId =
          parsed.searchParams.get(
            "user_id"
          );


        if (!userId) {

          return send(
            res,
            400,
            {

              success:
                false,

              error:
                "user_id is required"
            }
          );
        }


        try {

          const url =
            await getYoutubeAuthUrl(
              userId
            );


          /* =========================
             DIRECT REDIRECT TO GOOGLE
          ========================= */

          res.writeHead(
            302,
            {
              Location:
                url
            }
          );


          return res.end();

        } catch (error) {

          console.error(
            "YouTube connect error:",
            error.message
          );


          return send(
            res,
            500,
            {

              success:
                false,

              error:
                error.message
            }
          );
        }
      }


      /* =====================================================
         YOUTUBE CALLBACK
      ===================================================== */

      if (
        req.method === "GET" &&
        parsed.pathname ===
          "/youtube/callback"
      ) {

        const code =
          parsed.searchParams.get(
            "code"
          );


        const state =
          parsed.searchParams.get(
            "state"
          );


        if (
          !code ||
          !state
        ) {

          return send(
            res,
            400,
            {

              success:
                false,

              error:
                "Missing OAuth code or state"
            }
          );
        }


        try {

          const oauthState =
            await getOAuthState(
              state
            );


          if (
            !oauthState
          ) {

            return send(
              res,
              400,
              {

                success:
                  false,

                error:
                  "Invalid or expired OAuth state"
              }
            );
          }


          const oauth =
            youtubeClient();


          const tokenResult =
            await oauth.getToken(
              code
            );


          await saveYoutubeToken(
            oauthState.user_id,
            tokenResult.tokens
          );


          await deleteOAuthState(
            state
          );


          return send(
            res,
            200,
            {

              success:
                true,

              message:
                "YouTube account connected successfully. You can return to Telegram."
            }
          );

        } catch (error) {

          console.error(
            "YouTube callback error:",
            error.message
          );


          return send(
            res,
            500,
            {

              success:
                false,

              error:
                "YouTube authorization failed"
            }
          );
        }
      }


      /* =====================================================
         YOUTUBE STATUS
      ===================================================== */

      if (
        req.method === "GET" &&
        parsed.pathname ===
          "/youtube/status"
      ) {

        const userId =
          parsed.searchParams.get(
            "user_id"
          );


        if (!userId) {

          return send(
            res,
            400,
            {

              success:
                false,

              error:
                "user_id is required"
            }
          );
        }


        try {

          const result =
            await db.query(
              `
              SELECT user_id

              FROM youtube_accounts

              WHERE user_id = $1

              LIMIT 1
              `,
              [
                String(userId)
              ]
            );


          return send(
            res,
            200,
            {

              success:
                true,

              connected:
                result.rows.length > 0
            }
          );

        } catch (error) {

          return send(
            res,
            500,
            {

              success:
                false,

              error:
                error.message
            }
          );
        }
      }


      /* =====================================================
         YOUTUBE VERIFY
===================================================== */

      if (
        req.method === "GET" &&
        parsed.pathname ===
          "/youtube/verify"
      ) {

        const userId =
          parsed.searchParams.get(
            "user_id"
          );


        const taskId =
          parsed.searchParams.get(
            "task_id"
          );


        if (
          !userId ||
          !taskId
        ) {

          return send(
            res,
            400,
            {

              success:
                false,

              error:
                "user_id and task_id are required"
            }
          );
        }


        if (
          !Number.isInteger(
            Number(taskId)
          ) ||
          Number(taskId) <= 0
        ) {

          return send(
            res,
            400,
            {

              success:
                false,

              verified:
                false,

              error:
                "Invalid task_id"
            }
          );
        }


        try {

          const result =
            await verifyYoutubeTask(
              userId,
              Number(taskId)
            );


          return send(
            res,
            200,
            result
          );

        } catch (error) {

          console.error(
            "YouTube verification error:",
            error.message
          );


          return send(
            res,
            500,
            {

              success:
                false,

              verified:
                false,

              error:
                error.message
            }
          );
        }
      }


      /* =====================================================
         PAYMENT VERIFY
      ===================================================== */

      if (
        req.method === "GET" &&
        parsed.pathname ===
          "/verify-payment"
      ) {

        const txid =
          parsed.searchParams.get(
            "txid"
          );


        if (!txid) {

          return send(
            res,
            400,
            {

              verified:
                false,

              error:
                "TXID is required"
            }
          );
        }


        verifyPayment(

          txid,

          (result) => {

            send(

              res,

              result.error
                ? 502
                : 200,

              result
            );
          }
        );


        return;
      }


      /* =====================================================
         PAYOUT
      ===================================================== */

      if (
        req.method === "POST" &&
        parsed.pathname ===
          "/payout"
      ) {

        const providedSecret =
          String(
            req.headers[
              "x-api-secret"
            ] || ""
          );


        if (
          !PAYOUT_API_SECRET ||
          providedSecret !==
            PAYOUT_API_SECRET
        ) {

          return send(
            res,
            401,
            {

              success:
                false,

              error:
                "Unauthorized"
            }
          );
        }


        if (
          payoutBusy
        ) {

          return send(
            res,
            429,
            {

              success:
                false,

              error:
                "Another payout is currently processing"
            }
          );
        }


        try {

          const body =
            await readBody(req);


          const wallet =
            String(
              body.wallet || ""
            ).trim();


          const amount =
            Number(
              body.amount
            );


          const clientOid =
            String(
              body.clientOid || ""
            ).trim();


          if (
            !clientOid
          ) {

            throw new Error(
              "clientOid is required"
            );
          }


          if (
            processedPayouts.has(
              clientOid
            )
          ) {

            return send(
              res,
              409,
              {

                success:
                  false,

                error:
                  "This payout was already processed"
              }
            );
          }


          payoutBusy =
            true;


          const result =
            await sendPayout(
              wallet,
              amount,
              clientOid
            );


          processedPayouts.add(
            clientOid
          );


          return send(
            res,
            200,
            result
          );

        } catch (error) {

          console.error(
            "Payout error:",
            error.message
          );


          return send(
            res,
            400,
            {

              success:
                false,

              error:
                error.message ||
                "Payout failed"
            }
          );

        } finally {

          payoutBusy =
            false;
        }
      }


      /* =====================================================
         NOT FOUND
      ===================================================== */

      return send(
        res,
        404,
        {

          success:
            false,

          error:
            "Not Found"
        }
      );
    }
  );


/* =========================================================
   START SERVER
========================================================= */

server.listen(

  PORT,

  "0.0.0.0",

  async () => {

    console.log(
      "================================="
    );


    console.log(
      "Telegram Bot Backend Started"
    );


    console.log(
      "================================="
    );


    console.log(
      "Server running on port",
      PORT
    );


    console.log(
      "Payment wallet:",
      PAYMENT_WALLET
    );


    console.log(
      "USDT contract:",
      USDT_CONTRACT
    );


    console.log(
      "Payout wallet:",
      PAYOUT_WALLET
    );


    console.log(
      "Minimum withdraw:",
      MIN_WITHDRAW,
      "USDT"
    );


    console.log(
      "YouTube OAuth:",
      youtubeConfigured()
        ? "Configured"
        : "NOT CONFIGURED"
    );


    try {

      await initDatabase();

    } catch (error) {

      console.error(
        "Database initialization error:",
        error.message
      );
    }
  }
);
