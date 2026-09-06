const http = require("http");
const https = require("https");
const { ethers } = require("ethers");

/* =====================================================
   SERVER
===================================================== */

const PORT = process.env.PORT || 3000;


/* =====================================================
   PAYMENT SETTINGS
===================================================== */

const PAYMENT_WALLET =
  "0x07207Bf282B4e3dc2db376F29e40bfbc7d61607B".toLowerCase();

const USDT_CONTRACT =
  "0x55d398326f99059ff775485246999027b3197955".toLowerCase();

const BSC_RPC =
  "https://bsc-dataseed.bnbchain.org";

const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a8df523b3ef";

const USDT_DECIMALS = 18;


/* =====================================================
   PAYOUT SETTINGS
===================================================== */

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


/* =====================================================
   RPC REQUEST
===================================================== */

function rpcRequest(method, params, callback) {

  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: Date.now(),
    method: method,
    params: params
  });

  const url = new URL(BSC_RPC);

  const options = {
    hostname: url.hostname,
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

      res.on("data", (chunk) => {
        data += chunk;
      });

      res.on("end", () => {

        try {

          const json = JSON.parse(data);

          if (json.error) {

            return callback({
              error:
                json.error.message ||
                "BSC RPC error"
            });

          }

          callback(null, json.result);

        } catch (e) {

          callback({
            error:
              "Invalid BSC RPC response"
          });

        }

      });

    }
  );

  req.on("error", (err) => {

    callback({
      error:
        err.message ||
        "BSC RPC connection failed"
    });

  });

  req.write(body);
  req.end();
}


/* =====================================================
   GET LATEST BLOCK
===================================================== */

function getLatestBlock(callback) {

  rpcRequest(
    "eth_blockNumber",
    [],
    (error, result) => {

      if (error) {
        return callback(error);
      }

      try {

        callback(
          null,
          parseInt(result, 16)
        );

      } catch (e) {

        callback({
          error:
            "Could not read latest block"
        });

      }

    }
  );
}


/* =====================================================
   VERIFY BSC USDT PAYMENT
===================================================== */

function verifyPayment(txHash, callback) {

  txHash = String(txHash || "").trim();

  if (
    !/^0x[a-fA-F0-9]{64}$/.test(txHash)
  ) {

    return callback({
      verified: false,
      reason: "Invalid TXID"
    });

  }


  /* ---------------------------------------------
     Get transaction receipt
  --------------------------------------------- */

  rpcRequest(
    "eth_getTransactionReceipt",
    [txHash],
    (receiptError, receipt) => {

      if (receiptError) {

        return callback({
          verified: false,
          reason:
            receiptError.error ||
            "Could not read transaction receipt"
        });

      }


      if (!receipt) {

        return callback({
          verified: false,
          reason:
            "Transaction is pending or not found"
        });

      }


      /* -------------------------------------------
         Transaction success
      ------------------------------------------- */

      if (
        String(receipt.status).toLowerCase() !==
        "0x1"
      ) {

        return callback({
          verified: false,
          reason:
            "Transaction failed"
        });

      }


      /* -------------------------------------------
         Read Transfer logs
      ------------------------------------------- */

      const logs =
        Array.isArray(receipt.logs)
          ? receipt.logs
          : [];


      let payment = null;


      for (const log of logs) {

        const contract =
          String(log.address || "")
            .toLowerCase();


        if (
          contract !==
          USDT_CONTRACT
        ) {
          continue;
        }


        if (
          !Array.isArray(log.topics) ||
          log.topics.length < 3
        ) {
          continue;
        }


        /* Transfer(address,address,uint256) */

        if (
          String(log.topics[0]).toLowerCase() !==
          TRANSFER_TOPIC
        ) {
          continue;
        }


        const from =
          "0x" +
          String(log.topics[1])
            .slice(-40)
            .toLowerCase();


        const to =
          "0x" +
          String(log.topics[2])
            .slice(-40)
            .toLowerCase();


        /* Must come to our payment wallet */

        if (
          to !==
          PAYMENT_WALLET
        ) {
          continue;
        }


        let rawValue;

        try {

          rawValue =
            BigInt(
              String(log.data || "0x0")
            );

        } catch (e) {

          continue;

        }


        if (
          rawValue <= 0n
        ) {
          continue;
        }


        const amount =
          Number(
            ethers.formatUnits(
              rawValue.toString(),
              USDT_DECIMALS
            )
          );


        if (
          !Number.isFinite(amount) ||
          amount <= 0
        ) {
          continue;
        }


        payment = {

          from: from,

          to: to,

          amount: amount,

          rawAmount:
            rawValue.toString(),

          blockNumber:
            parseInt(
              receipt.blockNumber,
              16
            )

        };


        break;

      }


      /* -------------------------------------------
         No matching USDT transfer
      ------------------------------------------- */

      if (!payment) {

        return callback({

          verified: false,

          reason:
            "No BEP-20 USDT Transfer to the payment wallet was found"

        });

      }


      /* -------------------------------------------
         Confirmation count
      ------------------------------------------- */

      getLatestBlock(
        (blockError, latestBlock) => {

          if (blockError) {

            return callback({

              verified: false,

              reason:
                blockError.error ||
                "Could not check confirmations"

            });

          }


          const confirmations =
            Math.max(
              0,
              latestBlock -
              payment.blockNumber +
              1
            );


          /*
             We require at least 3 confirmations.
          */

          if (
            confirmations < 3
          ) {

            return callback({

              verified: false,

              reason:
                "Transaction has only " +
                confirmations +
                " confirmations. Required: 3",

              confirmations:
                confirmations,

              amount:
                payment.amount,

              txHash:
                txHash

            });

          }


          /* ---------------------------------------
             SUCCESS
          --------------------------------------- */

          callback({

            verified: true,

            txHash:
              txHash,

            amount:
              payment.amount,

            from:
              payment.from,

            to:
              payment.to,

            blockNumber:
              payment.blockNumber,

            confirmations:
              confirmations,

            network:
              "BEP-20 / BSC",

            token:
              "USDT"

          });

        }
      );

    }
  );
}


/* =====================================================
   PAYOUT
===================================================== */

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
      BSC_RPC,
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
      USDT_DECIMALS
    );


  const balance =
    await usdt.balanceOf(
      signerAddress
    );


  if (
    balance < rawAmount
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

    success: true,

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


/* =====================================================
   READ JSON BODY
===================================================== */

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
            10000
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
            return resolve({});
          }


          try {

            resolve(
              JSON.parse(body)
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


/* =====================================================
   HTTP SERVER
===================================================== */

const server =
  http.createServer(
    async (req, res) => {

      const parsed =
        new URL(
          req.url,
          `http://${req.headers.host}`
        );


      /* =================================================
         HOME
      ================================================= */

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


      /* =================================================
         PAYMENT VERIFY
      ================================================= */

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

              reason:
                "TXID is required"

            })
          );

        }


        verifyPayment(
          txid,
          (result) => {

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

          }
        );


        return;

      }


      /* =================================================
         PAYOUT
      ================================================= */

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


          const result =
            await sendPayout(
              wallet,
              amount,
              clientOid
            );


          res.writeHead(
            200,
            {
              "Content-Type":
                "application/json"
            }
          );


          return res.end(
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


          return res.end(
            JSON.stringify({

              success:
                false,

              error:
                error.message ||
                "Payout failed"

            })
          );

        }

      }


      /* =================================================
         404
      ================================================= */

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


/* =====================================================
   START
===================================================== */

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
