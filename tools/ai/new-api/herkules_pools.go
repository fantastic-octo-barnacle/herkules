package model

import (
	"os"
	"strings"
)

// Enabled only in our dedicated deployment. Unknown remote models are not admitted by its gateway.
func HerkulesPlansEnabled() bool { return os.Getenv("HERKULES_PLANS_ENABLED") == "true" }
func HerkulesCloudModel(name string) bool {
	if !HerkulesPlansEnabled() {
		return false
	}
	for _, allowed := range strings.Split(os.Getenv("HERKULES_CLOUD_MODELS"), ",") {
		if allowed != "" && name == allowed {
			return true
		}
	}
	return false
}
func HerkulesPlanMatches(plan *SubscriptionPlan, name string) bool {
	if !HerkulesPlansEnabled() {
		return true
	}
	if HerkulesCloudModel(name) {
		return plan.HerkulesPool == "cloud"
	}
	return plan.HerkulesPool == "local" || plan.HerkulesPool == ""
}

func HerkulesWalletOverflow(userID int, name string) (bool, error) {
	if !HerkulesPlansEnabled() {
		return UserActiveSubscriptionsAllowWalletOverflow(userID)
	}
	if HerkulesCloudModel(name) {
		return false, nil
	}
	subs, err := GetAllActiveUserSubscriptions(userID)
	if err != nil {
		return false, err
	}
	for _, summary := range subs {
		sub := summary.Subscription
		var plan SubscriptionPlan
		if err := DB.First(&plan, sub.PlanId).Error; err != nil {
			return false, err
		}
		if HerkulesPlanMatches(&plan, name) && !sub.AllowWalletOverflow {
			return false, nil
		}
	}
	return true, nil
}

// Only explicit free pool plans may bypass payment setup for administrator grants.
func HerkulesFreeGrantPlan(plan *SubscriptionPlan) bool {
	return HerkulesPlansEnabled() && plan != nil &&
		(plan.HerkulesPool == "local" || plan.HerkulesPool == "cloud") &&
		plan.PriceAmount == 0 && plan.AllowBalancePay != nil && !*plan.AllowBalancePay &&
		plan.StripePriceId == "" && plan.CreemProductId == "" && plan.WaffoPancakeProductId == ""
}
