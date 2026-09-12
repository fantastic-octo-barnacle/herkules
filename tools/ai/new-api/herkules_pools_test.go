package model

import "testing"

func TestHerkulesPoolIsolation(t *testing.T) {
	t.Setenv("HERKULES_PLANS_ENABLED", "true")
	t.Setenv("HERKULES_CLOUD_MODELS", "deepseek-flash,deepseek-v4-pro")
	for _, pool := range []string{"", "local", "cloud", "invalid"} {
		p := &SubscriptionPlan{HerkulesPool: pool}
		if HerkulesPlanMatches(p, "deepseek-flash") != (pool == "cloud") {
			t.Fatal("cloud pool leak", pool)
		}
		if HerkulesPlanMatches(p, "qwen3.8-27b") != (pool == "local" || pool == "") {
			t.Fatal("local pool leak", pool)
		}
	}
	if HerkulesCloudModel("deepseek-flash-attacker") {
		t.Fatal("model matching must be exact")
	}
}

func TestHerkulesReservationsCannotCrossPools(t *testing.T) {
	t.Setenv("HERKULES_PLANS_ENABLED", "true")
	t.Setenv("HERKULES_CLOUD_MODELS", "deepseek-flash")
	truncateTables(t)
	if err := DB.AutoMigrate(&SubscriptionPreConsumeRecord{}); err != nil {
		t.Fatal(err)
	}
	now := GetDBTimestamp()
	for i, pool := range []string{"local", "cloud"} {
		id := 9700 + i
		p := &SubscriptionPlan{Id: id, Title: pool, HerkulesPool: pool, TotalAmount: 1000, QuotaResetPeriod: "never"}
		if err := DB.Create(p).Error; err != nil {
			t.Fatal(err)
		}
		s := &UserSubscription{Id: id, UserId: 9710, PlanId: id, AmountTotal: 1000, Status: "active", StartTime: now, EndTime: now + 3600, AllowWalletOverflow: pool == "local"}
		if err := DB.Create(s).Error; err != nil {
			t.Fatal(err)
		}
	}
	local, err := PreConsumeUserSubscription("herkules-local", 9710, "qwen3.8-27b", 0, 100)
	if err != nil || local.UserSubscriptionId != 9700 {
		t.Fatal("local reservation", err)
	}
	cloud, err := PreConsumeUserSubscription("herkules-cloud", 9710, "deepseek-flash", 0, 900)
	if err != nil || cloud.UserSubscriptionId != 9701 {
		t.Fatal("cloud reservation", err)
	}
	if _, err = PreConsumeUserSubscription("herkules-cloud-overflow", 9710, "deepseek-flash", 0, 200); err == nil {
		t.Fatal("cloud spent local allowance")
	}
	if ok, err := HerkulesWalletOverflow(9710, "qwen3.8-27b"); err != nil || !ok {
		t.Fatal("local wallet blocked by cloud plan", err)
	}
	if ok, _ := HerkulesWalletOverflow(9710, "deepseek-flash"); ok {
		t.Fatal("cloud wallet fallback")
	}
	if err := PostConsumeUserSubscriptionDelta(cloud.UserSubscriptionId, -800); err != nil {
		t.Fatal(err)
	}
	if _, err := PreConsumeUserSubscription("herkules-cloud-after-refund", 9710, "deepseek-flash", 0, 900); err != nil {
		t.Fatal("unused reservation was not returned", err)
	}
}

func TestHerkulesFreeGrantPlan(t *testing.T) {
	t.Setenv("HERKULES_PLANS_ENABLED", "true")
	no, yes := false, true
	valid := SubscriptionPlan{HerkulesPool: "local", AllowBalancePay: &no}
	if !HerkulesFreeGrantPlan(&valid) {
		t.Fatal("free pool rejected")
	}
	for _, mutate := range []func(*SubscriptionPlan){
		func(p *SubscriptionPlan) { p.HerkulesPool = "" },
		func(p *SubscriptionPlan) { p.HerkulesPool = "invalid" },
		func(p *SubscriptionPlan) { p.PriceAmount = 1 },
		func(p *SubscriptionPlan) { p.AllowBalancePay = nil },
		func(p *SubscriptionPlan) { p.AllowBalancePay = &yes },
		func(p *SubscriptionPlan) { p.StripePriceId = "paid" },
		func(p *SubscriptionPlan) { p.CreemProductId = "paid" },
		func(p *SubscriptionPlan) { p.WaffoPancakeProductId = "paid" },
	} {
		p := valid
		mutate(&p)
		if HerkulesFreeGrantPlan(&p) {
			t.Fatalf("unsafe bypass: %+v", p)
		}
	}
	t.Setenv("HERKULES_PLANS_ENABLED", "false")
	if HerkulesFreeGrantPlan(&valid) || HerkulesFreeGrantPlan(nil) {
		t.Fatal("disabled bypass")
	}
}
