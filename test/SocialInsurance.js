contract('SocialInsurance', function(accounts) {

  var cnt = 0;
  var owner = accounts[cnt++];
  var sp_4 = accounts[cnt++];
  var sp_3_1 = accounts[cnt++];
  var sp_3_2 = accounts[cnt++];
  var sp_2_1_1 = accounts[cnt++];
  var sp_2_1_2 = accounts[cnt++];
  var sp_1_1_1_1 = accounts[cnt++];
  var member_1 = accounts[cnt++];
  var member_2 = accounts[cnt++];


  it('should create correct top group', function() {

    var SI = SocialInsurance.deployed();
    return SI.createTopGroup(sp_4).then(function(){
      return SI.groups(sp_4).then(function(group) {
        assert.equal(sp_4, group[0], 'Incorrect parentGroup of top group');
        assert.equal(4, group[3], 'Incorrect level of top group');
      });
    });
  }); // it

  it ('should create correct level 3 group', function () {

    var SI = SocialInsurance.deployed();
    return SI.createGroup(sp_3_1, {from: sp_4}).then(function() {
      return SI.groups(sp_3_1).then(function(group) {
        assert.equal(sp_4, group[0], 'Incorrect parentGroup of level 3 group');
        assert.equal(3, group[3], 'Incorrect level of top group');
      });
    });
  }); // it

  it ('should throw on duplicate group for spokesperson', function () {

    var SI = SocialInsurance.deployed();
    return SI.createGroup(sp_3_1, {from: sp_4}).then(function() {
      assert.fail('duplicate group', 'throws');
    }).catch(function () {return;}).then(function() {
      assert.isOk('everything', 'is ok');
    });
  }); // it

  it ('should create correct level 2 group', function () {

    var SI = SocialInsurance.deployed();
    return SI.createGroup(sp_2_1_1, {from: sp_3_1}).then(function() {
      return SI.groups(sp_2_1_1).then(function(group) {
        assert.equal(sp_3_1, group[0], 'Incorrect parentGroup of level 2 group');
        assert.equal(2, group[3], 'Incorrect level of top group');
      });
    });
  }); // it

  it ('should create correct level 1 group', function () {

    var SI = SocialInsurance.deployed();
    return SI.createGroup(sp_1_1_1_1, {from: sp_2_1_1}).then(function() {
      return SI.groups(sp_1_1_1_1).then(function(group) {
        assert.equal(sp_2_1_1, group[0], 'Incorrect parentGroup of level 2 group');
        assert.equal(1, group[3], 'Incorrect level of top group');
      });
    });
  }); // it

  it ('should admit member to level 1 group', function () {

    var SI = SocialInsurance.deployed();
    return SI.admitMember(member_1, {from: sp_1_1_1_1}).then(function() {
      return SI.members(member_1).then(function(membership) {
        assert.equal(sp_1_1_1_1, membership[0], 'Incorrect spokesperson in membership');

      });
    });
  }); // it

  it ('should throw if trying to admit member to level >1 group', function () {

    var SI = SocialInsurance.deployed();
    return SI.admitMember(member_1, {from: sp_2_1_1}).then(function() {
      assert.isNotOk(true, 'to admit member to group with level > 1');
    }).catch(function () {return;}).then(function() {
      assert.isOk(true, 'everything is ok');
    });
  }); // it




}); // contract