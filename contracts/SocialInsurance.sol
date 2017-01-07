/*

	Social Insurance - 
	Proposal for Blockchain UAE GovHack Competition
	(C) 2016 etherisc.com
	@Author Christoph Mussenbrock

 */

pragma solidity ^0.4.7;

contract SocialInsurance {

	modifier onlyOwner {
		if (msg.sender != owner) {
			throw;
		}
		_;
	}

	event LOG_memberPaidPremium(address _member, uint _value);

	uint8 public constant MAX_MEMBERS = 12;
	uint8 public constant MAX_LEVEL = 4;
	uint8 public constant LOCAL_LEVEL = 1;
	uint8 public constant NONE = 0x0;
	uint public constant WAIT_BLOCKS = 4 * 60 * 24 * 180; // blocks to wait till first payout


	/**
	 * A peergroup is either a local group of members (level == 0)
	 * or a group of groups (level > 0).
	 * A peergroup is identified by the address of its spokesperson.
	 */
	struct Peergroup {
		
		address parentGroup;
		string group_name;
		string spokesperson_name;
		string spokesperson_contact;
		uint balance;
		uint payouts;
		uint8 level;
		uint8 numberOfMembers;

	}

	/**
	 * A member has a group (identified by its spokesperson) 
	 * a balance (sum of all paid premiums) and
	 * a payouts (sum of all payouts)
	 */

	struct Membership {
		address group_spokesperson;
		uint joinedAtBlock;
		uint balance;
		uint payouts;
	}

	address public owner;
	address public rootSpokesperson; // spokesperson of top-level group

	uint public maxPayout;

	mapping(address => Peergroup) public groups;					// mapping of spokespersons to groups
	mapping(address => Membership) public members;					// mapping of members to spokespersons
	mapping(address => address[]) public group_members;	// 

	function SocialInsurance() {
		owner = msg.sender;
	}

	function createTopGroup (address _root_spokesperson, string _group_name, string _spokesperson_name, string _spokesperson_contact) 
		onlyOwner {
		if (rootSpokesperson != 0x0) {
			throw;
		}
		Peergroup topGroup = groups[_root_spokesperson];
		topGroup.parentGroup = _root_spokesperson;			// only in topGroup
		topGroup.group_name = _group_name;
		topGroup.spokesperson_name = _spokesperson_name;
		topGroup.spokesperson_contact = _spokesperson_contact;
		topGroup.level = MAX_LEVEL;
		rootSpokesperson = _root_spokesperson;
	}

	function createGroup(address _spokesperson, string _group_name, string _spokesperson_name, string _spokesperson_contact) {
		Peergroup group = groups[msg.sender];
		// Sanity check:
		if (group.parentGroup == NONE						// group doesn't exist
			|| group.level == LOCAL_LEVEL					// local groups can't have subgroups
			|| group.numberOfMembers >= MAX_MEMBERS) {		// group is full
			throw;
		}
		// create new group and assign to _elder's group
		group.numberOfMembers++;
		Peergroup childGroup = groups[_spokesperson];
		if (childGroup.parentGroup != NONE) {				// spokesperson must be unique
			throw;						
		}
		childGroup.parentGroup = msg.sender;
		childGroup.level = group.level - 1;
		childGroup.group_name = _group_name;
		childGroup.spokesperson_name = _spokesperson_name;
		childGroup.spokesperson_contact = _spokesperson_contact;
		group_members[msg.sender].push(_spokesperson);
		// other fields don't need initialization.
	}

	function setMaxPayout(uint _new_maxPayout)
		onlyOwner {
		maxPayout = _new_maxPayout;
	}

	function isMember(address _member) constant returns (bool) {
		return members[_member].group_spokesperson != NONE;
	}

	

	function admitMember (address _member) {
		Peergroup group = groups[msg.sender];
		if (isMember(_member) 								// Already member.
			|| group.parentGroup == NONE 					// group doesn't exist
			|| group.level > LOCAL_LEVEL					// not a local group
			|| group.numberOfMembers >= MAX_MEMBERS) 		// group is full
		{
			throw;
		}
		members[_member].group_spokesperson = msg.sender;
		members[_member].joinedAtBlock = block.number;
		group_members[msg.sender].push(_member);
	} 

	function propagatePremium(address _spokesperson, uint _premium) {
		Peergroup group = groups[_spokesperson];
		if (group.level == MAX_LEVEL) {
			group.balance += _premium;
			return;
		}
		uint half = _premium / 2;
		uint remain = _premium - half;
		group.balance += half;
		propagatePremium(group.parentGroup, remain);
	}

	function () payable {
		if (!isMember(msg.sender)) {
			throw;
		}
		address spokesperson = members[msg.sender].group_spokesperson;
		Peergroup group = groups[spokesperson];
		members[msg.sender].balance += msg.value;
		propagatePremium(spokesperson, msg.value);
		LOG_memberPaidPremium(msg.sender, msg.value);
	}

	function propagatePayout(address _spokesperson, uint _payout) returns (uint) {
		Peergroup group = groups[_spokesperson];
		uint actual_payout = 0;
		if (group.level == MAX_LEVEL) {
			if (group.balance > _payout) {
				actual_payout = _payout;
			} else {
				actual_payout = group.balance;
			}
			group.balance -= actual_payout;
			return actual_payout;
		}
		uint half = _payout / 2;
		if (group.balance > half) {
			actual_payout = half;
		} else {
			actual_payout = group.balance;
		}
		group.balance -= actual_payout;
		actual_payout = actual_payout + propagatePayout(group.parentGroup, _payout - actual_payout);
		return actual_payout;
	}

	function payout(address _member, uint _payout) {
		if (!isMember(_member)) {
			throw;
		}
		if (members[_member].joinedAtBlock < block.number + WAIT_BLOCKS ) {
			throw;
		}
		address spokesperson = members[_member].group_spokesperson;
		if (spokesperson != msg.sender) {
			throw;
		}
		Peergroup group = groups[spokesperson];
		uint actual_payout = propagatePayout(spokesperson, _payout);
		if (actual_payout > maxPayout) {
			throw;
		}
		if (!_member.send(actual_payout)) {
			throw;
		}
	}

}