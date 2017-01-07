var Web3 = require("web3");
var SolidityEvent = require("web3/lib/web3/event.js");

(function() {
  // Planned for future features, logging, etc.
  function Provider(provider) {
    this.provider = provider;
  }

  Provider.prototype.send = function() {
    this.provider.send.apply(this.provider, arguments);
  };

  Provider.prototype.sendAsync = function() {
    this.provider.sendAsync.apply(this.provider, arguments);
  };

  var BigNumber = (new Web3()).toBigNumber(0).constructor;

  var Utils = {
    is_object: function(val) {
      return typeof val == "object" && !Array.isArray(val);
    },
    is_big_number: function(val) {
      if (typeof val != "object") return false;

      // Instanceof won't work because we have multiple versions of Web3.
      try {
        new BigNumber(val);
        return true;
      } catch (e) {
        return false;
      }
    },
    merge: function() {
      var merged = {};
      var args = Array.prototype.slice.call(arguments);

      for (var i = 0; i < args.length; i++) {
        var object = args[i];
        var keys = Object.keys(object);
        for (var j = 0; j < keys.length; j++) {
          var key = keys[j];
          var value = object[key];
          merged[key] = value;
        }
      }

      return merged;
    },
    promisifyFunction: function(fn, C) {
      var self = this;
      return function() {
        var instance = this;

        var args = Array.prototype.slice.call(arguments);
        var tx_params = {};
        var last_arg = args[args.length - 1];

        // It's only tx_params if it's an object and not a BigNumber.
        if (Utils.is_object(last_arg) && !Utils.is_big_number(last_arg)) {
          tx_params = args.pop();
        }

        tx_params = Utils.merge(C.class_defaults, tx_params);

        return new Promise(function(accept, reject) {
          var callback = function(error, result) {
            if (error != null) {
              reject(error);
            } else {
              accept(result);
            }
          };
          args.push(tx_params, callback);
          fn.apply(instance.contract, args);
        });
      };
    },
    synchronizeFunction: function(fn, instance, C) {
      var self = this;
      return function() {
        var args = Array.prototype.slice.call(arguments);
        var tx_params = {};
        var last_arg = args[args.length - 1];

        // It's only tx_params if it's an object and not a BigNumber.
        if (Utils.is_object(last_arg) && !Utils.is_big_number(last_arg)) {
          tx_params = args.pop();
        }

        tx_params = Utils.merge(C.class_defaults, tx_params);

        return new Promise(function(accept, reject) {

          var decodeLogs = function(logs) {
            return logs.map(function(log) {
              var logABI = C.events[log.topics[0]];

              if (logABI == null) {
                return null;
              }

              var decoder = new SolidityEvent(null, logABI, instance.address);
              return decoder.decode(log);
            }).filter(function(log) {
              return log != null;
            });
          };

          var callback = function(error, tx) {
            if (error != null) {
              reject(error);
              return;
            }

            var timeout = C.synchronization_timeout || 240000;
            var start = new Date().getTime();

            var make_attempt = function() {
              C.web3.eth.getTransactionReceipt(tx, function(err, receipt) {
                if (err) return reject(err);

                if (receipt != null) {
                  // If they've opted into next gen, return more information.
                  if (C.next_gen == true) {
                    return accept({
                      tx: tx,
                      receipt: receipt,
                      logs: decodeLogs(receipt.logs)
                    });
                  } else {
                    return accept(tx);
                  }
                }

                if (timeout > 0 && new Date().getTime() - start > timeout) {
                  return reject(new Error("Transaction " + tx + " wasn't processed in " + (timeout / 1000) + " seconds!"));
                }

                setTimeout(make_attempt, 1000);
              });
            };

            make_attempt();
          };

          args.push(tx_params, callback);
          fn.apply(self, args);
        });
      };
    }
  };

  function instantiate(instance, contract) {
    instance.contract = contract;
    var constructor = instance.constructor;

    // Provision our functions.
    for (var i = 0; i < instance.abi.length; i++) {
      var item = instance.abi[i];
      if (item.type == "function") {
        if (item.constant == true) {
          instance[item.name] = Utils.promisifyFunction(contract[item.name], constructor);
        } else {
          instance[item.name] = Utils.synchronizeFunction(contract[item.name], instance, constructor);
        }

        instance[item.name].call = Utils.promisifyFunction(contract[item.name].call, constructor);
        instance[item.name].sendTransaction = Utils.promisifyFunction(contract[item.name].sendTransaction, constructor);
        instance[item.name].request = contract[item.name].request;
        instance[item.name].estimateGas = Utils.promisifyFunction(contract[item.name].estimateGas, constructor);
      }

      if (item.type == "event") {
        instance[item.name] = contract[item.name];
      }
    }

    instance.allEvents = contract.allEvents;
    instance.address = contract.address;
    instance.transactionHash = contract.transactionHash;
  };

  // Use inheritance to create a clone of this contract,
  // and copy over contract's static functions.
  function mutate(fn) {
    var temp = function Clone() { return fn.apply(this, arguments); };

    Object.keys(fn).forEach(function(key) {
      temp[key] = fn[key];
    });

    temp.prototype = Object.create(fn.prototype);
    bootstrap(temp);
    return temp;
  };

  function bootstrap(fn) {
    fn.web3 = new Web3();
    fn.class_defaults  = fn.prototype.defaults || {};

    // Set the network iniitally to make default data available and re-use code.
    // Then remove the saved network id so the network will be auto-detected on first use.
    fn.setNetwork("default");
    fn.network_id = null;
    return fn;
  };

  // Accepts a contract object created with web3.eth.contract.
  // Optionally, if called without `new`, accepts a network_id and will
  // create a new version of the contract abstraction with that network_id set.
  function Contract() {
    if (this instanceof Contract) {
      instantiate(this, arguments[0]);
    } else {
      var C = mutate(Contract);
      var network_id = arguments.length > 0 ? arguments[0] : "default";
      C.setNetwork(network_id);
      return C;
    }
  };

  Contract.currentProvider = null;

  Contract.setProvider = function(provider) {
    var wrapped = new Provider(provider);
    this.web3.setProvider(wrapped);
    this.currentProvider = provider;
  };

  Contract.new = function() {
    if (this.currentProvider == null) {
      throw new Error("SocialInsurance error: Please call setProvider() first before calling new().");
    }

    var args = Array.prototype.slice.call(arguments);

    if (!this.unlinked_binary) {
      throw new Error("SocialInsurance error: contract binary not set. Can't deploy new instance.");
    }

    var regex = /__[^_]+_+/g;
    var unlinked_libraries = this.binary.match(regex);

    if (unlinked_libraries != null) {
      unlinked_libraries = unlinked_libraries.map(function(name) {
        // Remove underscores
        return name.replace(/_/g, "");
      }).sort().filter(function(name, index, arr) {
        // Remove duplicates
        if (index + 1 >= arr.length) {
          return true;
        }

        return name != arr[index + 1];
      }).join(", ");

      throw new Error("SocialInsurance contains unresolved libraries. You must deploy and link the following libraries before you can deploy a new version of SocialInsurance: " + unlinked_libraries);
    }

    var self = this;

    return new Promise(function(accept, reject) {
      var contract_class = self.web3.eth.contract(self.abi);
      var tx_params = {};
      var last_arg = args[args.length - 1];

      // It's only tx_params if it's an object and not a BigNumber.
      if (Utils.is_object(last_arg) && !Utils.is_big_number(last_arg)) {
        tx_params = args.pop();
      }

      tx_params = Utils.merge(self.class_defaults, tx_params);

      if (tx_params.data == null) {
        tx_params.data = self.binary;
      }

      // web3 0.9.0 and above calls new twice this callback twice.
      // Why, I have no idea...
      var intermediary = function(err, web3_instance) {
        if (err != null) {
          reject(err);
          return;
        }

        if (err == null && web3_instance != null && web3_instance.address != null) {
          accept(new self(web3_instance));
        }
      };

      args.push(tx_params, intermediary);
      contract_class.new.apply(contract_class, args);
    });
  };

  Contract.at = function(address) {
    if (address == null || typeof address != "string" || address.length != 42) {
      throw new Error("Invalid address passed to SocialInsurance.at(): " + address);
    }

    var contract_class = this.web3.eth.contract(this.abi);
    var contract = contract_class.at(address);

    return new this(contract);
  };

  Contract.deployed = function() {
    if (!this.address) {
      throw new Error("Cannot find deployed address: SocialInsurance not deployed or address not set.");
    }

    return this.at(this.address);
  };

  Contract.defaults = function(class_defaults) {
    if (this.class_defaults == null) {
      this.class_defaults = {};
    }

    if (class_defaults == null) {
      class_defaults = {};
    }

    var self = this;
    Object.keys(class_defaults).forEach(function(key) {
      var value = class_defaults[key];
      self.class_defaults[key] = value;
    });

    return this.class_defaults;
  };

  Contract.extend = function() {
    var args = Array.prototype.slice.call(arguments);

    for (var i = 0; i < arguments.length; i++) {
      var object = arguments[i];
      var keys = Object.keys(object);
      for (var j = 0; j < keys.length; j++) {
        var key = keys[j];
        var value = object[key];
        this.prototype[key] = value;
      }
    }
  };

  Contract.all_networks = {
  "123": {
    "abi": [
      {
        "constant": true,
        "inputs": [
          {
            "name": "",
            "type": "address"
          }
        ],
        "name": "members",
        "outputs": [
          {
            "name": "group_spokesperson",
            "type": "address"
          },
          {
            "name": "balance",
            "type": "uint256"
          },
          {
            "name": "payouts",
            "type": "uint256"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "_member",
            "type": "address"
          },
          {
            "name": "_payout",
            "type": "uint256"
          }
        ],
        "name": "payout",
        "outputs": [],
        "payable": false,
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "_root_spokesperson",
            "type": "address"
          }
        ],
        "name": "createTopGroup",
        "outputs": [],
        "payable": false,
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "_new_maxPayout",
            "type": "uint256"
          }
        ],
        "name": "setMaxPayout",
        "outputs": [],
        "payable": false,
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "_spokesperson",
            "type": "address"
          }
        ],
        "name": "createGroup",
        "outputs": [],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [
          {
            "name": "",
            "type": "address"
          }
        ],
        "name": "groups",
        "outputs": [
          {
            "name": "parentGroup",
            "type": "address"
          },
          {
            "name": "balance",
            "type": "uint256"
          },
          {
            "name": "payouts",
            "type": "uint256"
          },
          {
            "name": "level",
            "type": "uint8"
          },
          {
            "name": "numberOfMembers",
            "type": "uint8"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "NONE",
        "outputs": [
          {
            "name": "",
            "type": "uint8"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "owner",
        "outputs": [
          {
            "name": "",
            "type": "address"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "_member",
            "type": "address"
          }
        ],
        "name": "admitMember",
        "outputs": [],
        "payable": false,
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "_member",
            "type": "address"
          }
        ],
        "name": "isMember",
        "outputs": [
          {
            "name": "",
            "type": "bool"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "MAX_LEVEL",
        "outputs": [
          {
            "name": "",
            "type": "uint8"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "rootSpokesperson",
        "outputs": [
          {
            "name": "",
            "type": "address"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "LOCAL_LEVEL",
        "outputs": [
          {
            "name": "",
            "type": "uint8"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "_spokesperson",
            "type": "address"
          },
          {
            "name": "_payout",
            "type": "uint256"
          }
        ],
        "name": "propagatePayout",
        "outputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "_spokesperson",
            "type": "address"
          },
          {
            "name": "_premium",
            "type": "uint256"
          }
        ],
        "name": "propagatePremium",
        "outputs": [],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "maxPayout",
        "outputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [
          {
            "name": "",
            "type": "address"
          },
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "name": "group_members",
        "outputs": [
          {
            "name": "",
            "type": "address"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "MAX_MEMBERS",
        "outputs": [
          {
            "name": "",
            "type": "uint8"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "inputs": [],
        "payable": false,
        "type": "constructor"
      },
      {
        "payable": true,
        "type": "fallback"
      },
      {
        "anonymous": false,
        "inputs": [
          {
            "indexed": false,
            "name": "_member",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "_value",
            "type": "uint256"
          }
        ],
        "name": "LOG_memberPaidPremium",
        "type": "event"
      }
    ],
    "unlinked_binary": "0x606060405234610000575b60008054600160a060020a03191633600160a060020a03161790555b5b610a3e806100366000396000f300606060405236156100e05763ffffffff60e060020a60003504166308ae4b0c8114610191578063117de2fd146101d25780634bbfa08b146101f057806356b4997f1461020b5780635c3f3b601461021d57806363d5e44d14610238578063835253941461028c5780638da5cb5b146102af5780639f7516fb146102d8578063a230c524146102f3578063a49062d414610320578063b1414b9a14610343578063b8d3bd9b1461036c578063bcf758631461038f578063dbd261ec146103bd578063e0176de8146103db578063e6e2ff8a146103fa578063ea0e35b114610432575b61018f5b600060006100f133610455565b15156100fc57610000565b5050600160a060020a03338116600081815260046020818152604080842080549096168085526003835290842094909352526001909201805434908101909155610147908390610478565b60408051600160a060020a033316815234602082015281517f477a15d3b6dcf880ac08b10541abc01267838270a190d890b6bb37ba3a3f2344929181900390910190a15b5050565b005b34610000576101aa600160a060020a03600435166104e8565b60408051600160a060020a039094168452602084019290925282820152519081900360600190f35b346100005761018f600160a060020a0360043516602435610513565b005b346100005761018f600160a060020a036004351661059e565b005b346100005761018f600435610608565b005b346100005761018f600160a060020a036004351661062d565b005b3461000057610251600160a060020a036004351661078f565b60408051600160a060020a03909616865260208601949094528484019290925260ff9081166060850152166080830152519081900360a00190f35b34610000576102996107ce565b6040805160ff9092168252519081900360200190f35b34610000576102bc6107d3565b60408051600160a060020a039092168252519081900360200190f35b346100005761018f600160a060020a03600435166107e2565b005b346100005761030c600160a060020a0360043516610455565b604080519115158252519081900360200190f35b34610000576102996108fc565b6040805160ff9092168252519081900360200190f35b34610000576102bc610901565b60408051600160a060020a039092168252519081900360200190f35b3461000057610299610910565b6040805160ff9092168252519081900360200190f35b34610000576103ab600160a060020a0360043516602435610915565b60408051918252519081900360200190f35b346100005761018f600160a060020a0360043516602435610478565b005b34610000576103ab6109c8565b60408051918252519081900360200190f35b34610000576102bc600160a060020a03600435166024356109ce565b60408051600160a060020a039092168252519081900360200190f35b3461000057610299610a0d565b6040805160ff9092168252519081900360200190f35b600160a060020a038082166000908152600460205260409020541615155b919050565b600160a060020a0382166000908152600360208190526040822090810154909190819060ff16600414156104b557600183018054850190556104e0565b5050600181018054600284049081019091558154818403906104e090600160a060020a031682610478565b5b5050505050565b600460205260009081526040902080546001820154600290920154600160a060020a03909116919083565b600160a060020a0380831660009081526004602052604081205482169181903316831461053f57610000565b600160a060020a038316600090815260036020526040902091506105638385610915565b604051909150600160a060020a0386169082156108fc029083906000818181858888f1935050505015156104e057610000565b5b5050505050565b6000805433600160a060020a039081169116146105ba57610000565b50600160a060020a03811660008181526003602081905260409091208054600160a060020a031990811684178255918101805460ff191660041790556001805490921690921790555b5b5050565b60005433600160a060020a0390811691161461062357610000565b60028190555b5b50565b600160a060020a0333811660009081526003602052604081208054909216158061065e5750600382015460ff166001145b8061067757506003820154600c61010090910460ff1610155b1561068157610000565b506003808201805460ff61010080830482166001019091160261ff0019909116179055600160a060020a03808416600090815260209290925260409091208054909116156106ce57610000565b8054600160a060020a03191633600160a060020a03169081178255600383810154908301805460ff191660ff9283166000190190921691909117905560009081526005602052604090208054600181018083558281838015829011610758576000838152602090206107589181019083015b808211156107545760008155600101610740565b5090565b5b505050916000526020600020900160005b8154600160a060020a038088166101009390930a92830292021916179055505b505050565b60036020819052600091825260409091208054600182015460028301549290930154600160a060020a0390911692919060ff8082169161010090041685565b600081565b600054600160a060020a031681565b600160a060020a033316600090815260036020526040902061080382610455565b8061081657508054600160a060020a0316155b8061082a57506003810154600160ff909116115b8061084357506003810154600c61010090910460ff1610155b1561084d57610000565b600160a060020a0382811660009081526004602090815260408083208054600160a060020a031916339095169485179055928252600590522080546001810180835582818380158290116108c6576000838152602090206108c69181019083015b808211156107545760008155600101610740565b5090565b5b505050916000526020600020900160005b8154600160a060020a038087166101009390930a92830292021916179055505b5050565b600481565b600154600160a060020a031681565b600181565b600160a060020a03821660009081526003602081905260408220908101548290819060ff16600414156109735784836001015411156109565784915061095e565b826001015491505b600183018054839003905590925082906109bf565b600285049050808360010154111561098d57809150610995565b826001015491505b600183018054839003905582546109b790600160a060020a0316838703610915565b820191508193505b50505092915050565b60025481565b600560205281600052604060002081815481101561000057906000526020600020900160005b915091509054906101000a9004600160a060020a031681565b600c815600a165627a7a723058204386335a7799661b6541e32ca6b614b54aa3c6ed63eb8ec38937a1262f918fa00029",
    "events": {
      "0x477a15d3b6dcf880ac08b10541abc01267838270a190d890b6bb37ba3a3f2344": {
        "anonymous": false,
        "inputs": [
          {
            "indexed": false,
            "name": "_member",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "_value",
            "type": "uint256"
          }
        ],
        "name": "LOG_memberPaidPremium",
        "type": "event"
      }
    },
    "updated_at": 1483659496617,
    "links": {},
    "address": "0xd2a5d47996a43a5a5e31ac57b6c0fdce13852c3c"
  },
  "default": {
    "abi": [
      {
        "constant": true,
        "inputs": [
          {
            "name": "",
            "type": "address"
          }
        ],
        "name": "members",
        "outputs": [
          {
            "name": "group_spokesperson",
            "type": "address"
          },
          {
            "name": "balance",
            "type": "uint256"
          },
          {
            "name": "payouts",
            "type": "uint256"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "_member",
            "type": "address"
          },
          {
            "name": "_payout",
            "type": "uint256"
          }
        ],
        "name": "payout",
        "outputs": [],
        "payable": false,
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "_root_spokesperson",
            "type": "address"
          }
        ],
        "name": "createTopGroup",
        "outputs": [],
        "payable": false,
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "_new_maxPayout",
            "type": "uint256"
          }
        ],
        "name": "setMaxPayout",
        "outputs": [],
        "payable": false,
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "_spokesperson",
            "type": "address"
          }
        ],
        "name": "createGroup",
        "outputs": [],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [
          {
            "name": "",
            "type": "address"
          }
        ],
        "name": "groups",
        "outputs": [
          {
            "name": "parentGroup",
            "type": "address"
          },
          {
            "name": "balance",
            "type": "uint256"
          },
          {
            "name": "payouts",
            "type": "uint256"
          },
          {
            "name": "level",
            "type": "uint8"
          },
          {
            "name": "numberOfMembers",
            "type": "uint8"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "NONE",
        "outputs": [
          {
            "name": "",
            "type": "uint8"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "owner",
        "outputs": [
          {
            "name": "",
            "type": "address"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "_member",
            "type": "address"
          }
        ],
        "name": "admitMember",
        "outputs": [],
        "payable": false,
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "_member",
            "type": "address"
          }
        ],
        "name": "isMember",
        "outputs": [
          {
            "name": "",
            "type": "bool"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "MAX_LEVEL",
        "outputs": [
          {
            "name": "",
            "type": "uint8"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "rootSpokesperson",
        "outputs": [
          {
            "name": "",
            "type": "address"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "LOCAL_LEVEL",
        "outputs": [
          {
            "name": "",
            "type": "uint8"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "_spokesperson",
            "type": "address"
          },
          {
            "name": "_payout",
            "type": "uint256"
          }
        ],
        "name": "propagatePayout",
        "outputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "_spokesperson",
            "type": "address"
          },
          {
            "name": "_premium",
            "type": "uint256"
          }
        ],
        "name": "propagatePremium",
        "outputs": [],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "maxPayout",
        "outputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [
          {
            "name": "",
            "type": "address"
          },
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "name": "group_members",
        "outputs": [
          {
            "name": "",
            "type": "address"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "MAX_MEMBERS",
        "outputs": [
          {
            "name": "",
            "type": "uint8"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "inputs": [],
        "payable": false,
        "type": "constructor"
      },
      {
        "payable": true,
        "type": "fallback"
      },
      {
        "anonymous": false,
        "inputs": [
          {
            "indexed": false,
            "name": "_member",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "_value",
            "type": "uint256"
          }
        ],
        "name": "LOG_memberPaidPremium",
        "type": "event"
      }
    ],
    "unlinked_binary": "0x606060405234610000575b60008054600160a060020a03191633600160a060020a03161790555b5b610a3e806100366000396000f300606060405236156100e05763ffffffff60e060020a60003504166308ae4b0c8114610191578063117de2fd146101d25780634bbfa08b146101f057806356b4997f1461020b5780635c3f3b601461021d57806363d5e44d14610238578063835253941461028c5780638da5cb5b146102af5780639f7516fb146102d8578063a230c524146102f3578063a49062d414610320578063b1414b9a14610343578063b8d3bd9b1461036c578063bcf758631461038f578063dbd261ec146103bd578063e0176de8146103db578063e6e2ff8a146103fa578063ea0e35b114610432575b61018f5b600060006100f133610455565b15156100fc57610000565b5050600160a060020a03338116600081815260046020818152604080842080549096168085526003835290842094909352526001909201805434908101909155610147908390610478565b60408051600160a060020a033316815234602082015281517f477a15d3b6dcf880ac08b10541abc01267838270a190d890b6bb37ba3a3f2344929181900390910190a15b5050565b005b34610000576101aa600160a060020a03600435166104e8565b60408051600160a060020a039094168452602084019290925282820152519081900360600190f35b346100005761018f600160a060020a0360043516602435610513565b005b346100005761018f600160a060020a036004351661059e565b005b346100005761018f600435610608565b005b346100005761018f600160a060020a036004351661062d565b005b3461000057610251600160a060020a036004351661078f565b60408051600160a060020a03909616865260208601949094528484019290925260ff9081166060850152166080830152519081900360a00190f35b34610000576102996107ce565b6040805160ff9092168252519081900360200190f35b34610000576102bc6107d3565b60408051600160a060020a039092168252519081900360200190f35b346100005761018f600160a060020a03600435166107e2565b005b346100005761030c600160a060020a0360043516610455565b604080519115158252519081900360200190f35b34610000576102996108fc565b6040805160ff9092168252519081900360200190f35b34610000576102bc610901565b60408051600160a060020a039092168252519081900360200190f35b3461000057610299610910565b6040805160ff9092168252519081900360200190f35b34610000576103ab600160a060020a0360043516602435610915565b60408051918252519081900360200190f35b346100005761018f600160a060020a0360043516602435610478565b005b34610000576103ab6109c8565b60408051918252519081900360200190f35b34610000576102bc600160a060020a03600435166024356109ce565b60408051600160a060020a039092168252519081900360200190f35b3461000057610299610a0d565b6040805160ff9092168252519081900360200190f35b600160a060020a038082166000908152600460205260409020541615155b919050565b600160a060020a0382166000908152600360208190526040822090810154909190819060ff16600414156104b557600183018054850190556104e0565b5050600181018054600284049081019091558154818403906104e090600160a060020a031682610478565b5b5050505050565b600460205260009081526040902080546001820154600290920154600160a060020a03909116919083565b600160a060020a0380831660009081526004602052604081205482169181903316831461053f57610000565b600160a060020a038316600090815260036020526040902091506105638385610915565b604051909150600160a060020a0386169082156108fc029083906000818181858888f1935050505015156104e057610000565b5b5050505050565b6000805433600160a060020a039081169116146105ba57610000565b50600160a060020a03811660008181526003602081905260409091208054600160a060020a031990811684178255918101805460ff191660041790556001805490921690921790555b5b5050565b60005433600160a060020a0390811691161461062357610000565b60028190555b5b50565b600160a060020a0333811660009081526003602052604081208054909216158061065e5750600382015460ff166001145b8061067757506003820154600c61010090910460ff1610155b1561068157610000565b506003808201805460ff61010080830482166001019091160261ff0019909116179055600160a060020a03808416600090815260209290925260409091208054909116156106ce57610000565b8054600160a060020a03191633600160a060020a03169081178255600383810154908301805460ff191660ff9283166000190190921691909117905560009081526005602052604090208054600181018083558281838015829011610758576000838152602090206107589181019083015b808211156107545760008155600101610740565b5090565b5b505050916000526020600020900160005b8154600160a060020a038088166101009390930a92830292021916179055505b505050565b60036020819052600091825260409091208054600182015460028301549290930154600160a060020a0390911692919060ff8082169161010090041685565b600081565b600054600160a060020a031681565b600160a060020a033316600090815260036020526040902061080382610455565b8061081657508054600160a060020a0316155b8061082a57506003810154600160ff909116115b8061084357506003810154600c61010090910460ff1610155b1561084d57610000565b600160a060020a0382811660009081526004602090815260408083208054600160a060020a031916339095169485179055928252600590522080546001810180835582818380158290116108c6576000838152602090206108c69181019083015b808211156107545760008155600101610740565b5090565b5b505050916000526020600020900160005b8154600160a060020a038087166101009390930a92830292021916179055505b5050565b600481565b600154600160a060020a031681565b600181565b600160a060020a03821660009081526003602081905260408220908101548290819060ff16600414156109735784836001015411156109565784915061095e565b826001015491505b600183018054839003905590925082906109bf565b600285049050808360010154111561098d57809150610995565b826001015491505b600183018054839003905582546109b790600160a060020a0316838703610915565b820191508193505b50505092915050565b60025481565b600560205281600052604060002081815481101561000057906000526020600020900160005b915091509054906101000a9004600160a060020a031681565b600c815600a165627a7a723058204386335a7799661b6541e32ca6b614b54aa3c6ed63eb8ec38937a1262f918fa00029",
    "events": {
      "0x477a15d3b6dcf880ac08b10541abc01267838270a190d890b6bb37ba3a3f2344": {
        "anonymous": false,
        "inputs": [
          {
            "indexed": false,
            "name": "_member",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "_value",
            "type": "uint256"
          }
        ],
        "name": "LOG_memberPaidPremium",
        "type": "event"
      }
    },
    "updated_at": 1483659486922
  }
};

  Contract.checkNetwork = function(callback) {
    var self = this;

    if (this.network_id != null) {
      return callback();
    }

    this.web3.version.network(function(err, result) {
      if (err) return callback(err);

      var network_id = result.toString();

      // If we have the main network,
      if (network_id == "1") {
        var possible_ids = ["1", "live", "default"];

        for (var i = 0; i < possible_ids.length; i++) {
          var id = possible_ids[i];
          if (Contract.all_networks[id] != null) {
            network_id = id;
            break;
          }
        }
      }

      if (self.all_networks[network_id] == null) {
        return callback(new Error(self.name + " error: Can't find artifacts for network id '" + network_id + "'"));
      }

      self.setNetwork(network_id);
      callback();
    })
  };

  Contract.setNetwork = function(network_id) {
    var network = this.all_networks[network_id] || {};

    this.abi             = this.prototype.abi             = network.abi;
    this.unlinked_binary = this.prototype.unlinked_binary = network.unlinked_binary;
    this.address         = this.prototype.address         = network.address;
    this.updated_at      = this.prototype.updated_at      = network.updated_at;
    this.links           = this.prototype.links           = network.links || {};
    this.events          = this.prototype.events          = network.events || {};

    this.network_id = network_id;
  };

  Contract.networks = function() {
    return Object.keys(this.all_networks);
  };

  Contract.link = function(name, address) {
    if (typeof name == "function") {
      var contract = name;

      if (contract.address == null) {
        throw new Error("Cannot link contract without an address.");
      }

      Contract.link(contract.contract_name, contract.address);

      // Merge events so this contract knows about library's events
      Object.keys(contract.events).forEach(function(topic) {
        Contract.events[topic] = contract.events[topic];
      });

      return;
    }

    if (typeof name == "object") {
      var obj = name;
      Object.keys(obj).forEach(function(name) {
        var a = obj[name];
        Contract.link(name, a);
      });
      return;
    }

    Contract.links[name] = address;
  };

  Contract.contract_name   = Contract.prototype.contract_name   = "SocialInsurance";
  Contract.generated_with  = Contract.prototype.generated_with  = "3.2.0";

  // Allow people to opt-in to breaking changes now.
  Contract.next_gen = false;

  var properties = {
    binary: function() {
      var binary = Contract.unlinked_binary;

      Object.keys(Contract.links).forEach(function(library_name) {
        var library_address = Contract.links[library_name];
        var regex = new RegExp("__" + library_name + "_*", "g");

        binary = binary.replace(regex, library_address.replace("0x", ""));
      });

      return binary;
    }
  };

  Object.keys(properties).forEach(function(key) {
    var getter = properties[key];

    var definition = {};
    definition.enumerable = true;
    definition.configurable = false;
    definition.get = getter;

    Object.defineProperty(Contract, key, definition);
    Object.defineProperty(Contract.prototype, key, definition);
  });

  bootstrap(Contract);

  if (typeof module != "undefined" && typeof module.exports != "undefined") {
    module.exports = Contract;
  } else {
    // There will only be one version of this contract in the browser,
    // and we can use that.
    window.SocialInsurance = Contract;
  }
})();
