import api from './api'

// Demo customer session: the gateway issues a short-lived customer token for an arbitrary customer ID.
// Used by the account-scoped aggregation calls. Not an authentication mechanism.
let sessionCache = { customerId: null, token: null, expiresAt: 0 }

export const openCustomerSession = async (customerId) => {
    const now = Date.now()
    if (sessionCache.customerId === customerId && sessionCache.token && now < sessionCache.expiresAt - 60000) {
        return sessionCache.token
    }
    const response = await api.post('/session', { customerId })
    sessionCache = {
        customerId,
        token: response.data.token,
        expiresAt: now + response.data.expiresInSeconds * 1000,
    }
    return sessionCache.token
}
