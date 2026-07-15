package com.aiplatform.backend.billing;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.math.BigDecimal;

@Data
@NoArgsConstructor
@AllArgsConstructor
public class BillingDecision {

    private BillingErrorCode code;
    private String message;
    private BigDecimal quotaCost;
    private BigDecimal walletCost;

    public static BillingDecision allow(BigDecimal quotaCost, BigDecimal walletCost) {
        return new BillingDecision(BillingErrorCode.OK, "OK",
                quotaCost != null ? quotaCost : BigDecimal.ZERO,
                walletCost != null ? walletCost : BigDecimal.ZERO);
    }

    public static BillingDecision reject(BillingErrorCode code, String message) {
        return new BillingDecision(code, message, BigDecimal.ZERO, BigDecimal.ZERO);
    }

    public boolean allowed() {
        return BillingErrorCode.OK.equals(code);
    }
}
