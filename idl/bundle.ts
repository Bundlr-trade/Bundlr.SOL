/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/bundle.json`.
 */
export type Bundle = {
  "address": "41NTbgRwNoyYUjSd9xCuf7Ny6ZUYgMxk6knq2Lpvy1RD",
  "metadata": {
    "name": "bundle",
    "version": "0.1.0",
    "spec": "0.1.0"
  },
  "instructions": [
    {
      "name": "createBundle",
      "docs": [
        "Curator-signed. Creates the bundle mint (authority = bundle PDA) and",
        "records the recipe. Nothing is deposited here. `qty_per_unit` is in the",
        "leg's base units per one whole bundle unit — the library sizes a unit at",
        "$100 of basket on launch day (q_i = w_i / p0_i)."
      ],
      "discriminator": [
        108,
        43,
        176,
        128,
        45,
        94,
        197,
        95
      ],
      "accounts": [
        {
          "name": "curator",
          "writable": true,
          "signer": true
        },
        {
          "name": "bundleMint",
          "writable": true,
          "signer": true
        },
        {
          "name": "bundle",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  110,
                  100,
                  108,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "bundleMint"
              }
            ]
          }
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "ticker",
          "type": "string"
        },
        {
          "name": "name",
          "type": "string"
        },
        {
          "name": "legs",
          "type": {
            "vec": {
              "defined": {
                "name": "legInput"
              }
            }
          }
        }
      ]
    },
    {
      "name": "faucet",
      "docs": [
        "Devnet only. Mints `amount` of a mock leg whose mint authority is the",
        "faucet PDA. Stands in for the Jupiter Zap where no real xStocks exist."
      ],
      "discriminator": [
        0,
        98,
        59,
        30,
        144,
        142,
        113,
        12
      ],
      "accounts": [
        {
          "name": "user",
          "signer": true
        },
        {
          "name": "faucet",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  97,
                  117,
                  99,
                  101,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "mint",
          "writable": true
        },
        {
          "name": "to",
          "writable": true
        },
        {
          "name": "tokenProgram"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "issue",
      "docs": [
        "Cash-in, bundle-out's last instruction. The Zap's swaps (or, on devnet,",
        "`faucet`) have already put the legs in the buyer's token accounts.",
        "Remaining accounts, four per leg in recipe order:",
        "leg_mint · buyer's leg ATA · vault (bundle PDA's ATA) · that leg's token program"
      ],
      "discriminator": [
        190,
        1,
        98,
        214,
        81,
        99,
        222,
        247
      ],
      "accounts": [
        {
          "name": "buyer",
          "writable": true,
          "signer": true
        },
        {
          "name": "bundle",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  110,
                  100,
                  108,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "bundleMint"
              }
            ]
          }
        },
        {
          "name": "bundleMint",
          "writable": true
        },
        {
          "name": "buyerUnits",
          "writable": true
        },
        {
          "name": "feeUnits",
          "writable": true
        },
        {
          "name": "tokenProgram"
        }
      ],
      "args": [
        {
          "name": "units",
          "type": "u64"
        }
      ]
    },
    {
      "name": "redeem",
      "docs": [
        "Burn units, take the underlying. Permissionless; this is the backing",
        "guarantee. The Zap's redeem-to-cash path appends Jupiter swaps after it.",
        "Remaining accounts as in `issue` (holder's leg ATA in slot 2)."
      ],
      "discriminator": [
        184,
        12,
        86,
        149,
        70,
        196,
        97,
        225
      ],
      "accounts": [
        {
          "name": "holder",
          "writable": true,
          "signer": true
        },
        {
          "name": "bundle",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  110,
                  100,
                  108,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "bundleMint"
              }
            ]
          }
        },
        {
          "name": "bundleMint",
          "writable": true
        },
        {
          "name": "holderUnits",
          "writable": true
        },
        {
          "name": "feeUnits",
          "writable": true
        },
        {
          "name": "tokenProgram"
        }
      ],
      "args": [
        {
          "name": "units",
          "type": "u64"
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "bundle",
      "discriminator": [
        15,
        82,
        167,
        230,
        37,
        214,
        82,
        80
      ]
    }
  ],
  "events": [
    {
      "name": "bundleCreated",
      "discriminator": [
        248,
        105,
        64,
        162,
        34,
        23,
        35,
        139
      ]
    },
    {
      "name": "issued",
      "discriminator": [
        13,
        203,
        75,
        37,
        35,
        96,
        248,
        250
      ]
    },
    {
      "name": "redeemed",
      "discriminator": [
        14,
        29,
        183,
        71,
        31,
        165,
        107,
        38
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "legCount",
      "msg": "a bundle is 2 to 9 legs"
    },
    {
      "code": 6001,
      "name": "tooLong",
      "msg": "ticker over 8 or name over 48 chars"
    },
    {
      "code": 6002,
      "name": "zeroQty",
      "msg": "qty_per_unit must be > 0"
    },
    {
      "code": 6003,
      "name": "duplicateLeg",
      "msg": "duplicate leg mint"
    },
    {
      "code": 6004,
      "name": "zeroUnits",
      "msg": "units must be > 0"
    },
    {
      "code": 6005,
      "name": "legAccounts",
      "msg": "pass four accounts per leg, in recipe order"
    },
    {
      "code": 6006,
      "name": "legMismatch",
      "msg": "leg mint does not match the recipe"
    },
    {
      "code": 6007,
      "name": "vaultMismatch",
      "msg": "vault is not the bundle's ATA for this leg"
    },
    {
      "code": 6008,
      "name": "overflow",
      "msg": "arithmetic overflow"
    }
  ],
  "types": [
    {
      "name": "bundle",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "curator",
            "type": "pubkey"
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "ticker",
            "type": "string"
          },
          {
            "name": "name",
            "type": "string"
          },
          {
            "name": "legs",
            "type": {
              "vec": {
                "defined": {
                  "name": "leg"
                }
              }
            }
          },
          {
            "name": "feeBps",
            "type": "u16"
          },
          {
            "name": "unitsOutstanding",
            "type": "u64"
          },
          {
            "name": "createdAt",
            "type": "i64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "bundleCreated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bundle",
            "type": "pubkey"
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "curator",
            "type": "pubkey"
          },
          {
            "name": "legs",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "issued",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bundle",
            "type": "pubkey"
          },
          {
            "name": "buyer",
            "type": "pubkey"
          },
          {
            "name": "units",
            "type": "u64"
          },
          {
            "name": "fee",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "leg",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "qtyPerUnit",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "legInput",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "qtyPerUnit",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "redeemed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bundle",
            "type": "pubkey"
          },
          {
            "name": "holder",
            "type": "pubkey"
          },
          {
            "name": "units",
            "type": "u64"
          },
          {
            "name": "fee",
            "type": "u64"
          }
        ]
      }
    }
  ]
};
