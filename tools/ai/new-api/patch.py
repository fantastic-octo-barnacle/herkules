"""Apply narrow, checked extensions to the checksum-pinned New API source."""
import pathlib,sys
root=pathlib.Path(sys.argv[1])
def replace(path,before,after):
 p=root/path;s=p.read_text()
 if s.count(before)!=1:raise RuntimeError('New API patch drift: '+path)
 p.write_text(s.replace(before,after))
replace('model/subscription.go','type SubscriptionPlan struct {','type SubscriptionPlan struct {\n\tHerkulesPool string `json:"herkules_pool" gorm:"type:varchar(16);default:\'\'"`')
replace('model/subscription.go','\t\t\tif err := maybeResetUserSubscriptionWithPlanTx(tx, &sub, plan, now); err != nil {','\t\t\tif !HerkulesPlanMatches(plan, modelName) { continue }\n\t\t\tif err := maybeResetUserSubscriptionWithPlanTx(tx, &sub, plan, now); err != nil {')
replace('service/billing_session.go','\tpref := common.NormalizeBillingPreference(relayInfo.UserSetting.BillingPreference)','\tpref := common.NormalizeBillingPreference(relayInfo.UserSetting.BillingPreference)\n\t// Cloud requests can never consume the local wallet, regardless of user preference.\n\tif model.HerkulesCloudModel(relayInfo.GetBillingModelName()) { pref = "subscription_only" }')
# Resolve the plan before allowing the narrowly scoped free-grant exception.
for name in ['AdminCreateSubscriptionPlan','AdminUpdateSubscriptionPlan','AdminBindSubscription','AdminCreateUserSubscription']:
 p=root/'controller/subscription.go';s=p.read_text();start=s.index('func '+name+'(');end=s.index('\n}',start)+2;part=s[start:end]
 gate='\tif !requirePaymentCompliance(c) {\n\t\treturn\n\t}\n'
 if part.count(gate)!=1:raise RuntimeError('Compliance patch drift: '+name)
 part=part.replace(gate,'',1)
 if name in ['AdminCreateSubscriptionPlan','AdminUpdateSubscriptionPlan']:
  marker='\tif strings.TrimSpace(req.Plan.Title) == "" {'
  check='\tif !model.HerkulesFreeGrantPlan(&req.Plan) && !requirePaymentCompliance(c) { return }\n'
 else:
  marker='\tmsg, err := model.AdminBindSubscription('
  check='\tvar plan model.SubscriptionPlan\n\tif err := model.DB.First(&plan, req.PlanId).Error; err != nil { common.ApiError(c, err); return }\n\tif !model.HerkulesFreeGrantPlan(&plan) && !requirePaymentCompliance(c) { return }\n'
 if part.count(marker)!=1:raise RuntimeError('Plan resolution patch drift: '+name)
 part=part.replace(marker,check+marker,1)
 s=s[:start]+part+s[end:];p.write_text(s)
for name in ['herkules_pools.go','herkules_pools_test.go']:
 (root/'model'/name).write_text((pathlib.Path(__file__).parent/name).read_text())
replace('service/billing_session.go','model.UserActiveSubscriptionsAllowWalletOverflow(relayInfo.UserId)','model.HerkulesWalletOverflow(relayInfo.UserId, relayInfo.GetBillingModelName())')
replace('controller/misc.go','"version":                     common.Version,','"version":                     common.Version,\n\t\t"herkules_pools": gin.H{"enabled": model.HerkulesPlansEnabled(), "deepseek_flash": model.HerkulesCloudModel("deepseek-flash"), "deepseek_pro": model.HerkulesCloudModel("deepseek-v4-pro")},')
