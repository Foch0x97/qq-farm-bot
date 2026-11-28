import type { ActivityRouteContext } from './types';

export function mountActivityOverviewRoutes({ app, ctx, withAccount, mountGet }: ActivityRouteContext): void {
    mountGet('/api/activity-center/activities', 'getActivityDirectorySnapshot');
    mountGet('/api/activity-center/ranch-activities', 'getRanchActivityDirectorySnapshot');
    mountGet('/api/activity-center/snapshot', 'getActivityCenterSnapshot');
    mountGet('/api/activity-center/maple-market', 'getMapleMarketOverview');
    mountGet('/api/activity-center/maple-market/purchase-records', 'getMapleMarketPurchaseRecords');
    app.post('/api/activity-center/maple-market/claim-seeds', withAccount(id => ctx.provider.claimMapleMarketSeeds(id)));
    app.post('/api/activity-center/maple-market/share', withAccount(id => ctx.provider.shareMapleMarketQuote(id)));
    app.post('/api/activity-center/maple-market/exchange', withAccount((id, req) => (
        ctx.provider.exchangeMapleMarketGoods(id, req.body?.index, req.body?.price, req.body?.remaining, req.body?.count)
    )));
}
