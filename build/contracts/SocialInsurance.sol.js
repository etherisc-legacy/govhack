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
            "name": "joinedAtBlock",
            "type": "uint256"
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
            "name": "group_name",
            "type": "string"
          },
          {
            "name": "spokesperson_name",
            "type": "string"
          },
          {
            "name": "spokesperson_contact",
            "type": "string"
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
        "constant": false,
        "inputs": [
          {
            "name": "_spokesperson",
            "type": "address"
          },
          {
            "name": "_group_name",
            "type": "string"
          },
          {
            "name": "_spokesperson_name",
            "type": "string"
          },
          {
            "name": "_spokesperson_contact",
            "type": "string"
          }
        ],
        "name": "createGroup",
        "outputs": [],
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
        "constant": true,
        "inputs": [],
        "name": "WAIT_BLOCKS",
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
        "constant": true,
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
        "constant": false,
        "inputs": [
          {
            "name": "_root_spokesperson",
            "type": "address"
          },
          {
            "name": "_group_name",
            "type": "string"
          },
          {
            "name": "_spokesperson_name",
            "type": "string"
          },
          {
            "name": "_spokesperson_contact",
            "type": "string"
          }
        ],
        "name": "createTopGroup",
        "outputs": [],
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
    "unlinked_binary": "0x606060405234610000575b60008054600160a060020a03191633600160a060020a03161790555b5b6111e0806100366000396000f300606060405236156100eb5763ffffffff60e060020a60003504166308ae4b0c811461019c578063117de2fd146101e557806356b4997f1461020357806363d5e44d146102155780636ab25ed7146103df57806383525394146104b85780638da5cb5b146104db5780639874a3d0146105045780639f7516fb14610523578063a230c5241461053e578063a49062d41461056b578063b1414b9a1461058e578063b8d3bd9b146105b7578063bcf75863146105da578063dbd261ec14610608578063e0176de814610626578063e6e2ff8a14610645578063ea0e35b11461067d578063ffc6ae83146106a0575b61019a5b600060006100fc33610779565b151561010757610000565b5050600160a060020a0333811660008181526004602081815260408084208054909616808552600383529084209490935252600290920180543490810190915561015290839061079c565b60408051600160a060020a033316815234602082015281517f477a15d3b6dcf880ac08b10541abc01267838270a190d890b6bb37ba3a3f2344929181900390910190a15b5050565b005b34610000576101b5600160a060020a036004351661080b565b60408051600160a060020a0390951685526020850193909352838301919091526060830152519081900360800190f35b346100005761019a600160a060020a036004351660243561083c565b005b346100005761019a60043561091a565b005b346100005761022e600160a060020a036004351661093f565b60408051600160a060020a038a1681526080810186905260a0810185905260ff80851660c0830152831660e0820152610100602082018181528a546002600019600183161585020190911604918301829052919283019060608401906101208501908c9080156102df5780601f106102b4576101008083540402835291602001916102df565b820191906000526020600020905b8154815290600101906020018083116102c257829003601f168201915b505084810383528a54600260001961010060018416150201909116048082526020909101908b9080156103535780601f1061032857610100808354040283529160200191610353565b820191906000526020600020905b81548152906001019060200180831161033657829003601f168201915b505084810382528954600260001961010060018416150201909116048082526020909101908a9080156103c75780601f1061039c576101008083540402835291602001916103c7565b820191906000526020600020905b8154815290600101906020018083116103aa57829003601f168201915b50509b50505050505050505050505060405180910390f35b346100005760408051602060046024803582810135601f810185900485028601850190965285855261019a958335600160a060020a0316959394604494939290920191819084018382808284375050604080516020601f89358b0180359182018390048302840183019094528083529799988101979196509182019450925082915084018382808284375050604080516020601f89358b0180359182018390048302840183019094528083529799988101979196509182019450925082915084018382808284375094965061098b95505050505050565b005b34610000576104c5610cd2565b6040805160ff9092168252519081900360200190f35b34610000576104e8610cd7565b60408051600160a060020a039092168252519081900360200190f35b3461000057610511610ce6565b60408051918252519081900360200190f35b346100005761019a600160a060020a0360043516610ced565b005b3461000057610557600160a060020a0360043516610779565b604080519115158252519081900360200190f35b34610000576104c5610e32565b6040805160ff9092168252519081900360200190f35b34610000576104e8610e37565b60408051600160a060020a039092168252519081900360200190f35b34610000576104c5610e46565b6040805160ff9092168252519081900360200190f35b3461000057610511600160a060020a0360043516602435610e4b565b60408051918252519081900360200190f35b346100005761019a600160a060020a036004351660243561079c565b005b3461000057610511610efd565b60408051918252519081900360200190f35b34610000576104e8600160a060020a0360043516602435610f03565b60408051600160a060020a039092168252519081900360200190f35b34610000576104c5610f42565b6040805160ff9092168252519081900360200190f35b346100005760408051602060046024803582810135601f810185900485028601850190965285855261019a958335600160a060020a0316959394604494939290920191819084018382808284375050604080516020601f89358b0180359182018390048302840183019094528083529799988101979196509182019450925082915084018382808284375050604080516020601f89358b01803591820183900483028401830190945280835297999881019791965091820194509250829150840183828082843750949650610f4795505050505050565b005b600160a060020a038082166000908152600460205260409020541615155b919050565b600160a060020a03821660009081526003602052604081206006810154909190819060ff16600414156107d85760048301805485019055610803565b50506004810180546002840490810190915581548184039061080390600160a060020a03168261079c565b5b5050505050565b6004602052600090815260409020805460018201546002830154600390930154600160a060020a0390921692909184565b60006000600061084b85610779565b1580610858575060025484115b1561086257610000565b600160a060020a03851660009081526004602052604090206001015443620fd2000190101561089057610000565b600160a060020a0380861660009081526004602052604090205481169350331683146108bb57610000565b600160a060020a038316600090815260036020526040902091506108df8385610e4b565b604051909150600160a060020a0386169082156108fc029083906000818181858888f19350505050151561080357610000565b5b5050505050565b60005433600160a060020a0390811691161461093557610000565b60028190555b5b50565b60036020819052600091825260409091208054600482015460058301546006840154600160a060020a039093169460018501946002810194910192919060ff8082169161010090041688565b600160a060020a033381166000908152600360205260408120805490921615806109bc5750600682015460ff166001145b806109d557506006820154600c61010090910460ff1610155b156109df57610000565b5060068101805460ff61010080830482166001019091160261ff0019909116179055600160a060020a038086166000908152600360205260409020805490911615610a2957610000565b8054600160a060020a03191633600160a060020a0316178155600682810154908201805460ff191660ff92831660001990810190931617905585516001808401805460008281526020908190209295600261010095841615959095020190911692909204601f908101839004820193928a0190839010610ab457805160ff1916838001178555610ae1565b82800160010185558215610ae1579182015b82811115610ae1578251825591602001919060010190610ac6565b5b50610b029291505b80821115610afe5760008155600101610aea565b5090565b505083816002019080519060200190828054600181600116156101000203166002900490600052602060002090601f016020900481019282601f10610b5257805160ff1916838001178555610b7f565b82800160010185558215610b7f579182015b82811115610b7f578251825591602001919060010190610b64565b5b50610ba09291505b80821115610afe5760008155600101610aea565b5090565b505082816003019080519060200190828054600181600116156101000203166002900490600052602060002090601f016020900481019282601f10610bf057805160ff1916838001178555610c1d565b82800160010185558215610c1d579182015b82811115610c1d578251825591602001919060010190610c02565b5b50610c3e9291505b80821115610afe5760008155600101610aea565b5090565b5050600160a060020a03331660009081526005602052604090208054600181018083558281838015829011610c9857600083815260209020610c989181019083015b80821115610afe5760008155600101610aea565b5090565b5b505050916000526020600020900160005b8154600160a060020a03808b166101009390930a92830292021916179055505b505050505050565b600081565b600054600160a060020a031681565b620fd20081565b600160a060020a0333166000908152600360205260409020610d0e82610779565b80610d2157508054600160a060020a0316155b80610d3557506006810154600160ff909116115b80610d4e57506006810154600c61010090910460ff1610155b15610d5857610000565b60068101805461ff0019811660016101009283900460ff90811682011690920217909155600160a060020a0383811660009081526004602090815260408083208054600160a060020a0319163390951694851781554390860155928252600590522080549182018082559091908281838015829011610dfc57600083815260209020610dfc9181019083015b80821115610afe5760008155600101610aea565b5090565b5b505050916000526020600020900160005b8154600160a060020a038087166101009390930a92830292021916179055505b5050565b600481565b600154600160a060020a031681565b600181565b600160a060020a038216600090815260036020526040812060068101548290819060ff1660041415610ea8578483600401541115610e8b57849150610e93565b826004015491505b60048301805483900390559092508290610ef4565b6002850490508083600401541115610ec257809150610eca565b826004015491505b60048301805483900390558254610eec90600160a060020a0316838703610e4b565b820191508193505b50505092915050565b60025481565b600560205281600052604060002081815481101561000057906000526020600020900160005b915091509054906101000a9004600160a060020a031681565b600c81565b6000805433600160a060020a03908116911614610f6357610000565b600154600160a060020a031615610f7957610000565b50600160a060020a038416600081815260036020908152604082208054600160a060020a031916909317835585516001808501805481865294849020909460026101009382161593909302600019011691909104601f908101849004820193890190839010610ff357805160ff1916838001178555611020565b82800160010185558215611020579182015b82811115611020578251825591602001919060010190611005565b5b506110419291505b80821115610afe5760008155600101610aea565b5090565b505082816002019080519060200190828054600181600116156101000203166002900490600052602060002090601f016020900481019282601f1061109157805160ff19168380011785556110be565b828001600101855582156110be579182015b828111156110be5782518255916020019190600101906110a3565b5b506110df9291505b80821115610afe5760008155600101610aea565b5090565b505081816003019080519060200190828054600181600116156101000203166002900490600052602060002090601f016020900481019282601f1061112f57805160ff191683800117855561115c565b8280016001018555821561115c579182015b8281111561115c578251825591602001919060010190611141565b5b5061117d9291505b80821115610afe5760008155600101610aea565b5090565b505060068101805460ff1916600417905560018054600160a060020a038716600160a060020a03199091161790555b5b50505050505600a165627a7a72305820c085f227ac8fe55d60f8c0e5626e735414eeb85aa52ce6d5167472b0fbd163700029",
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
    "updated_at": 1483795890950,
    "links": {},
    "address": "0xc715601c5429f7633333d7220d0099fe9d062b2f"
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
            "name": "joinedAtBlock",
            "type": "uint256"
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
            "name": "group_name",
            "type": "string"
          },
          {
            "name": "spokesperson_name",
            "type": "string"
          },
          {
            "name": "spokesperson_contact",
            "type": "string"
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
        "constant": false,
        "inputs": [
          {
            "name": "_spokesperson",
            "type": "address"
          },
          {
            "name": "_group_name",
            "type": "string"
          },
          {
            "name": "_spokesperson_name",
            "type": "string"
          },
          {
            "name": "_spokesperson_contact",
            "type": "string"
          }
        ],
        "name": "createGroup",
        "outputs": [],
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
        "constant": true,
        "inputs": [],
        "name": "WAIT_BLOCKS",
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
        "constant": true,
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
        "constant": false,
        "inputs": [
          {
            "name": "_root_spokesperson",
            "type": "address"
          },
          {
            "name": "_group_name",
            "type": "string"
          },
          {
            "name": "_spokesperson_name",
            "type": "string"
          },
          {
            "name": "_spokesperson_contact",
            "type": "string"
          }
        ],
        "name": "createTopGroup",
        "outputs": [],
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
    "unlinked_binary": "0x606060405234610000575b60008054600160a060020a03191633600160a060020a03161790555b5b6111c2806100366000396000f300606060405236156100eb5763ffffffff60e060020a60003504166308ae4b0c811461019c578063117de2fd146101e557806356b4997f1461020357806363d5e44d146102155780636ab25ed7146103df57806383525394146104b85780638da5cb5b146104db5780639874a3d0146105045780639f7516fb14610523578063a230c5241461053e578063a49062d41461056b578063b1414b9a1461058e578063b8d3bd9b146105b7578063bcf75863146105da578063dbd261ec14610608578063e0176de814610626578063e6e2ff8a14610645578063ea0e35b11461067d578063ffc6ae83146106a0575b61019a5b600060006100fc33610779565b151561010757610000565b5050600160a060020a0333811660008181526004602081815260408084208054909616808552600383529084209490935252600290920180543490810190915561015290839061079c565b60408051600160a060020a033316815234602082015281517f477a15d3b6dcf880ac08b10541abc01267838270a190d890b6bb37ba3a3f2344929181900390910190a15b5050565b005b34610000576101b5600160a060020a036004351661080b565b60408051600160a060020a0390951685526020850193909352838301919091526060830152519081900360800190f35b346100005761019a600160a060020a036004351660243561083c565b005b346100005761019a60043561091c565b005b346100005761022e600160a060020a0360043516610941565b60408051600160a060020a038a1681526080810186905260a0810185905260ff80851660c0830152831660e0820152610100602082018181528a546002600019600183161585020190911604918301829052919283019060608401906101208501908c9080156102df5780601f106102b4576101008083540402835291602001916102df565b820191906000526020600020905b8154815290600101906020018083116102c257829003601f168201915b505084810383528a54600260001961010060018416150201909116048082526020909101908b9080156103535780601f1061032857610100808354040283529160200191610353565b820191906000526020600020905b81548152906001019060200180831161033657829003601f168201915b505084810382528954600260001961010060018416150201909116048082526020909101908a9080156103c75780601f1061039c576101008083540402835291602001916103c7565b820191906000526020600020905b8154815290600101906020018083116103aa57829003601f168201915b50509b50505050505050505050505060405180910390f35b346100005760408051602060046024803582810135601f810185900485028601850190965285855261019a958335600160a060020a0316959394604494939290920191819084018382808284375050604080516020601f89358b0180359182018390048302840183019094528083529799988101979196509182019450925082915084018382808284375050604080516020601f89358b0180359182018390048302840183019094528083529799988101979196509182019450925082915084018382808284375094965061098d95505050505050565b005b34610000576104c5610cd4565b6040805160ff9092168252519081900360200190f35b34610000576104e8610cd9565b60408051600160a060020a039092168252519081900360200190f35b3461000057610511610ce8565b60408051918252519081900360200190f35b346100005761019a600160a060020a0360043516610cef565b005b3461000057610557600160a060020a0360043516610779565b604080519115158252519081900360200190f35b34610000576104c5610e14565b6040805160ff9092168252519081900360200190f35b34610000576104e8610e19565b60408051600160a060020a039092168252519081900360200190f35b34610000576104c5610e28565b6040805160ff9092168252519081900360200190f35b3461000057610511600160a060020a0360043516602435610e2d565b60408051918252519081900360200190f35b346100005761019a600160a060020a036004351660243561079c565b005b3461000057610511610edf565b60408051918252519081900360200190f35b34610000576104e8600160a060020a0360043516602435610ee5565b60408051600160a060020a039092168252519081900360200190f35b34610000576104c5610f24565b6040805160ff9092168252519081900360200190f35b346100005760408051602060046024803582810135601f810185900485028601850190965285855261019a958335600160a060020a0316959394604494939290920191819084018382808284375050604080516020601f89358b0180359182018390048302840183019094528083529799988101979196509182019450925082915084018382808284375050604080516020601f89358b01803591820183900483028401830190945280835297999881019791965091820194509250829150840183828082843750949650610f2995505050505050565b005b600160a060020a038082166000908152600460205260409020541615155b919050565b600160a060020a03821660009081526003602052604081206006810154909190819060ff16600414156107d85760048301805485019055610803565b50506004810180546002840490810190915581548184039061080390600160a060020a03168261079c565b5b5050505050565b6004602052600090815260409020805460018201546002830154600390930154600160a060020a0390921692909184565b60006000600061084b85610779565b151561085657610000565b600160a060020a03851660009081526004602052604090206001015443620fd2000190101561088457610000565b600160a060020a0380861660009081526004602052604090205481169350331683146108af57610000565b600160a060020a038316600090815260036020526040902091506108d38385610e2d565b90506002548111156108e457610000565b604051600160a060020a0386169082156108fc029083906000818181858888f19350505050151561080357610000565b5b5050505050565b60005433600160a060020a0390811691161461093757610000565b60028190555b5b50565b60036020819052600091825260409091208054600482015460058301546006840154600160a060020a039093169460018501946002810194910192919060ff8082169161010090041688565b600160a060020a033381166000908152600360205260408120805490921615806109be5750600682015460ff166001145b806109d757506006820154600c61010090910460ff1610155b156109e157610000565b5060068101805460ff61010080830482166001019091160261ff0019909116179055600160a060020a038086166000908152600360205260409020805490911615610a2b57610000565b8054600160a060020a03191633600160a060020a0316178155600682810154908201805460ff191660ff92831660001990810190931617905585516001808401805460008281526020908190209295600261010095841615959095020190911692909204601f908101839004820193928a0190839010610ab657805160ff1916838001178555610ae3565b82800160010185558215610ae3579182015b82811115610ae3578251825591602001919060010190610ac8565b5b50610b049291505b80821115610b005760008155600101610aec565b5090565b505083816002019080519060200190828054600181600116156101000203166002900490600052602060002090601f016020900481019282601f10610b5457805160ff1916838001178555610b81565b82800160010185558215610b81579182015b82811115610b81578251825591602001919060010190610b66565b5b50610ba29291505b80821115610b005760008155600101610aec565b5090565b505082816003019080519060200190828054600181600116156101000203166002900490600052602060002090601f016020900481019282601f10610bf257805160ff1916838001178555610c1f565b82800160010185558215610c1f579182015b82811115610c1f578251825591602001919060010190610c04565b5b50610c409291505b80821115610b005760008155600101610aec565b5090565b5050600160a060020a03331660009081526005602052604090208054600181018083558281838015829011610c9a57600083815260209020610c9a9181019083015b80821115610b005760008155600101610aec565b5090565b5b505050916000526020600020900160005b8154600160a060020a03808b166101009390930a92830292021916179055505b505050505050565b600081565b600054600160a060020a031681565b620fd20081565b600160a060020a0333166000908152600360205260409020610d1082610779565b80610d2357508054600160a060020a0316155b80610d3757506006810154600160ff909116115b80610d5057506006810154600c61010090910460ff1610155b15610d5a57610000565b600160a060020a0382811660009081526004602090815260408083208054600160a060020a031916339095169485178155436001918201559383526005909152902080549182018082559091908281838015829011610dde57600083815260209020610dde9181019083015b80821115610b005760008155600101610aec565b5090565b5b505050916000526020600020900160005b8154600160a060020a038087166101009390930a92830292021916179055505b5050565b600481565b600154600160a060020a031681565b600181565b600160a060020a038216600090815260036020526040812060068101548290819060ff1660041415610e8a578483600401541115610e6d57849150610e75565b826004015491505b60048301805483900390559092508290610ed6565b6002850490508083600401541115610ea457809150610eac565b826004015491505b60048301805483900390558254610ece90600160a060020a0316838703610e2d565b820191508193505b50505092915050565b60025481565b600560205281600052604060002081815481101561000057906000526020600020900160005b915091509054906101000a9004600160a060020a031681565b600c81565b6000805433600160a060020a03908116911614610f4557610000565b600154600160a060020a031615610f5b57610000565b50600160a060020a038416600081815260036020908152604082208054600160a060020a031916909317835585516001808501805481865294849020909460026101009382161593909302600019011691909104601f908101849004820193890190839010610fd557805160ff1916838001178555611002565b82800160010185558215611002579182015b82811115611002578251825591602001919060010190610fe7565b5b506110239291505b80821115610b005760008155600101610aec565b5090565b505082816002019080519060200190828054600181600116156101000203166002900490600052602060002090601f016020900481019282601f1061107357805160ff19168380011785556110a0565b828001600101855582156110a0579182015b828111156110a0578251825591602001919060010190611085565b5b506110c19291505b80821115610b005760008155600101610aec565b5090565b505081816003019080519060200190828054600181600116156101000203166002900490600052602060002090601f016020900481019282601f1061111157805160ff191683800117855561113e565b8280016001018555821561113e579182015b8281111561113e578251825591602001919060010190611123565b5b5061115f9291505b80821115610b005760008155600101610aec565b5090565b505060068101805460ff1916600417905560018054600160a060020a038716600160a060020a03199091161790555b5b50505050505600a165627a7a72305820855d704814362e184f3384ea446bd9e3861b8dfa984265989cc5a4cba55973f00029",
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
    "updated_at": 1483785025229
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
