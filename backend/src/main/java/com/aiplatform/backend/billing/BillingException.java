package com.aiplatform.backend.billing;

public class BillingException extends RuntimeException {

    private final BillingErrorCode code;

    private final BillingDecision decision;

    public BillingException(BillingErrorCode code, String message) {
        super(message);
        this.code = code;
        this.decision = BillingDecision.reject(code, message);
    }

    public BillingException(BillingDecision decision) {
        super(decision != null ? decision.getMessage() : "Billing failed");
        this.code = decision != null ? decision.getCode() : BillingErrorCode.INTERNAL_ERROR;
        this.decision = decision;
    }

    public BillingErrorCode getCode() {
        return code;
    }

    public BillingDecision getDecision() {
        return decision;
    }
}
