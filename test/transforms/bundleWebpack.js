var expect = require('../unexpected-with-plugins');
var AssetGraph = require('../../lib/');

describe('bundleWebpack', function () {
    it('should create a bundle consisting of a single file', function () {
        return new AssetGraph({root: __dirname + '/../../testdata/transforms/bundleWebpack/simple/'})
.logEvents()
            .loadAssets('index.html')
            .populate()
            .bundleWebpack()
            .populate()
            .queue(function (assetGraph) {
                expect(assetGraph, 'to contain asset', 'JavaScript');
                expect(assetGraph, 'to contain relations', { type: 'HtmlScript', from: { url: /index\.html$/} }, 1);
                expect(assetGraph, 'to contain asset', {
                    type: 'JavaScript',
                    fileName: /bundle/
                });
                expect(assetGraph.findRelations({
                    from: { url: /index\.html$/ },
                    to: { fileName: /bundle/ }
                })[0].to.text, 'to contain', 'alert(\'main!\');');
            });

    });
});
