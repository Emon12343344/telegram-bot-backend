const http = require("http");
const https = require("https");
const { ethers } = require("ethers");

const PORT = process.env.PORT || 3000;


/* =========================================================
   PAYMENT SETTINGS
========================================================= */

const PAYMENT_WALLET =
  "0x07207Bf282B4e3dc2db376F29e40bfbc7d61607B7".toLowerCase();

const RPC_URL =
  "https://bsc-dataseed.bnbchain.org";

const USDT_CONTRACT =
  "0x55d398326f99059ff775485246999027b3197955".toLowerCase();

const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";


/* =========================================================
   PAYOUT SETTINGS
========================================================= */

const PAYOUT_WALLET =
  String(process.env.PAYOUT_WALLET || "").toLowerCase();

const PAYOUT_PRIVATE_KEY =
  String(process.env.PAYOUT_PRIVATE_KEY || "");

const PAYOUT_API_SECRET =
  String(process.env.PAYOUT_API_SECRET || "");

let MIN_WITHDRAW =
  Number(process.env.MIN_WITHDRAW || 0.15);

if (
  !Number.isFinite(MIN_WITHDRAW) ||
  MIN_WITHDRAW <= 0
) {
  MIN_WITHDRAW = 0.15;
}

let payoutBusy = false;

const processedPayouts = new Set();


/* =========================================================
   RPC REQUEST
========================================================= */

function rpcRequest(method, params, callback) {

  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: Date.now(),
    method: method,
    params: params
  });

  const url = new URL(RPC_URL);

  const options = {
    hostname: url.hostname,
    port: 443,
    path: url.pathname,
    method: "POST",

    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body)
    }
  };

  const req = https.request(
    options,
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
              JSON.parse(data);

            if (json.error) {

              return callback({
                error:
                  json.error.message ||
                  "BSC RPC error"
              });

            }

            return callback(
              null,
              json.result
            );

          } catch (e) {

            return callback({
              error:
                "Invalid BSC RPC response"
            });

          }

        }
      );

    }
  );

  req.on(
    "error",
    (error) => {

      callback({
        error:
          error.message ||
          "BSC RPC connection failed"
      });

    }
  );

  req.setTimeout(
    20000,
    () => {

      req.destroy();

      callback({
        error:
          "BSC RPC request timeout"
      });

    }
  );

  req.write(body);
  req.end();
}


/* =========================================================
   VERIFY PAYMENT
========================================================= */

function verifyPayment(
  txHash,
  callback
) {

  const hash =
    String(txHash || "").trim();


  /* -------------------------
     TXID VALIDATION
  ------------------------- */

  if (
    !/^0x[a-fA-F0-9]{64}$/.test(hash)
  ) {

    return callback({
      verified: false,
      reason:
        "Invalid transaction hash"
    });

  }


  /* -------------------------
     GET TRANSACTION
  ------------------------- */

  rpcRequest(
    "eth_getTransactionByHash",
    [hash],
    (txError, tx) => {

      if (txError) {

        return callback({
          verified: false,
          error:
            txError.error ||
            "Could not read transaction"
        });

      }


      if (!tx) {

        return callback({
          verified: false,
          reason:
            "Transaction not found on BNB Smart Chain"
        });

      }


      /* -------------------------
         MAKE SURE IT IS USDT CONTRACT
      ------------------------- */

      const txTo =
        String(tx.to || "").toLowerCase();


      if (
        txTo !== USDT_CONTRACT
      ) {

        return callback({
          verified: false,
          reason:
            "Transaction is not a USDT contract transaction"
        });

      }


      /* -------------------------
         RECEIPT
      ------------------------- */

      rpcRequest(
        "eth_getTransactionReceipt",
        [hash],
        (receiptError, receipt) => {

          if (receiptError) {

            return callback({
              verified: false,
              error:
                receiptError.error ||
                "Could not get transaction receipt"
            });

          }


          if (!receipt) {

            return callback({
              verified: false,
              reason:
                "Transaction is still pending"
            });

          }


          /* -------------------------
             TRANSACTION STATUS
          ------------------------- */

          const status =
            String(
              receipt.status || ""
            ).toLowerCase();


          if (status !== "0x1") {

            return callback({
              verified: false,
              reason:
                "Transaction failed"
            });

          }


          /* -------------------------
             LOGS
          ------------------------- */

          const logs =
            Array.isArray(receipt.logs)
              ? receipt.logs
              : [];


          let foundPayment = null;


          for (
            let i = 0;
            i < logs.length;
            i++
          ) {

            const log =
              logs[i];


            /* Contract */

            const logAddress =
              String(
                log.address || ""
              ).toLowerCase();


            if (
              logAddress !==
              USDT_CONTRACT
            ) {
              continue;
            }


            /* Topics */

            if (
              !Array.isArray(log.topics) ||
              log.topics.length < 3
            ) {
              continue;
            }


            /* Transfer event */

            const topic0 =
              String(
                log.topics[0] || ""
              ).toLowerCase();


            if (
              topic0 !==
              TRANSFER_TOPIC
            ) {
              continue;
            }


            /* From */

            const from =
              (
                "0x" +
                String(
                  log.topics[1]
                ).slice(-40)
              ).toLowerCase();


            /* To */

            const to =
              (
                "0x" +
                String(
                  log.topics[2]
                ).slice(-40)
              ).toLowerCase();


            /* Must arrive at payment wallet */

            if (
              to !==
              PAYMENT_WALLET
            ) {
              continue;
            }


            /* -------------------------
               RAW USDT AMOUNT
            ------------------------- */

            const data =
              String(
                log.data || "0x0"
              );


            let rawValue;

            try {

              rawValue =
                BigInt(data);

            } catch (e) {

              continue;

            }


            if (
              rawValue <= 0n
            ) {
              continue;
            }


            /*
              BNB Chain USDT uses 18 decimals.
            */

            const amount =
              Number(rawValue) /
              Math.pow(10, 18);


            if (
              !Number.isFinite(amount) ||
              amount <= 0
            ) {
              continue;
            }


            foundPayment = {

              from:
                from,

              to:
                to,

              amount:
                amount,

              rawValue:
                rawValue.toString(),

              blockNumber:
                receipt.blockNumber

            };


            break;

          }


          /* -------------------------
             NO PAYMENT FOUND
          ------------------------- */

          if (!foundPayment) {

            return callback({

              verified:
                false,

              reason:
                "USDT Transfer to the payment wallet was not found in this transaction"

            });

          }


          /* -------------------------
             SUCCESS
          ------------------------- */

          return callback({

            verified:
              true,

            txHash:
              hash,

            amount:
              foundPayment.amount,

            rawValue:
              foundPayment.rawValue,

            from:
              foundPayment.from,

            to:
              foundPayment.to,

            blockNumber:
              foundPayment.blockNumber,

            network:
              "BEP-20 / BNB Smart Chain",

            token:
              "USDT"

          });

        }
      );

    }
  );
}


/* =========================================================
   AUTOMATIC USDT PAYOUT
========================================================= */

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
    payoutAmount < MIN_WITHDRAW
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


  /* -------------------------
     PROVIDER
  ------------------------- */

  const provider =
    new ethers.JsonRpcProvider(
      RPC_URL,
      56
    );


  /* -------------------------
     SIGNER
  ------------------------- */

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


  /* -------------------------
     USDT CONTRACT
  ------------------------- */

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


  /* -------------------------
     BALANCE
  ------------------------- */

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
    usdtBalance < rawAmount
  ) {

    throw new Error(
      "Payout wallet has insufficient USDT balance"
    );

  }


  /* -------------------------
     SEND
  ------------------------- */

  const tx =
    await usdt.transfer(
      walletAddress,
      rawAmount
    );


  console.log(
    "Payout TX submitted:",
    tx.hash
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
      "BEP-20"

  };

}


/* =========================================================
   READ REQUEST BODY
========================================================= */

function readBody(req) {

  return new Promise(
    (resolve, reject) => {

      let body = "";


      req.on(
        "data",
        (chunk) => {

          body += chunk;


          if (
            body.length > 10000
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


/* =========================================================
   HTTP SERVER
========================================================= */

const server =
  http.createServer(
    async (req, res) => {

      const parsed =
        new URL(
          req.url,
          `http://${req.headers.host}`
        );


      /* =====================================================
         HOME
      ===================================================== */

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


      /* =====================================================
         VERIFY PAYMENT
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

          res.writeHead(
            400,
            {
              "Content-Type":
                "application/json"
            }
          );


          return res.end(
            JSON.stringify({

              verified:
                false,

              error:
                "TXID is required"

            })
          );

        }


        console.log(
          "Payment verification requested:",
          txid
        );


        verifyPayment(
          txid,
          (result) => {

            console.log(
              "Payment verification result:",
              result
            );


            res.writeHead(
              result.error
                ? 502
                : 200,

              {
                "Content-Type":
                  "application/json"
              }
            );


            res.end(
              JSON.stringify(
                result
              )
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
        parsed.pathname === "/payout"
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

          res.writeHead(
            401,
            {
              "Content-Type":
                "application/json"
            }
          );


          return res.end(
            JSON.stringify({

              success:
                false,

              error:
                "Unauthorized"

            })
          );

        }


        if (payoutBusy) {

          res.writeHead(
            429,
            {
              "Content-Type":
                "application/json"
            }
          );


          return res.end(
            JSON.stringify({

              success:
                false,

              error:
                "Another payout is currently processing"

            })
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

            res.writeHead(
              409,
              {
                "Content-Type":
                  "application/json"
              }
            );


            return res.end(
              JSON.stringify({

                success:
                  false,

                error:
                  "This payout was already processed"

              })
            );

          }


          payoutBusy = true;


          console.log(
            "Payout requested:",
            {
              wallet:
                wallet,

              amount:
                amount,

              clientOid:
                clientOid,

              minimum:
                MIN_WITHDRAW
            }
          );


          const result =
            await sendPayout(
              wallet,
              amount,
              clientOid
            );


          processedPayouts.add(
            clientOid
          );


          console.log(
            "Payout sent:",
            result
          );


          res.writeHead(
            200,
            {
              "Content-Type":
                "application/json"
            }
          );


          res.end(
            JSON.stringify(
              result
            )
          );


        } catch (error) {

          console.error(
            "Payout error:",
            error.message
          );


          res.writeHead(
            400,
            {
              "Content-Type":
                "application/json"
            }
          );


          res.end(
            JSON.stringify({

              success:
                false,

              error:
                error.message ||
                "Payout failed"

            })
          );


        } finally {

          payoutBusy = false;

        }


        return;

      }


      /* =====================================================
         NOT FOUND
      ===================================================== */

      res.writeHead(
        404,
        {
          "Content-Type":
            "text/plain"
        }
      );


      res.end(
        "Not Found"
      );

    }
  );


/* =========================================================
   START SERVER
========================================================= */

server.listen(
  PORT,
  "0.0.0.0",
  () => {

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

  }
);
