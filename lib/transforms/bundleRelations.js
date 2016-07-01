var _ = require('lodash'),
    urlTools = require('urltools'),
    postcss = require('postcss'),
    AssetGraph = require('../');

module.exports = function (queryObj, options) {
    options = options || {};
    var bundleStrategyName = options.strategyName || 'oneBundlePerIncludingAsset';

    return function bundleRelations(assetGraph) {
        function getDiscriminatorForRelation(relation) {
            var discriminatorFragments = [],
                i,
                attribute;
            discriminatorFragments.push(relation.type); // HtmlScript vs. JavaScriptImportScripts
            if (relation.to.isLoaded) {
                discriminatorFragments.push('isLoaded');
            }
            var isInsideHead = false,
                parentNode = relation.node.parentNode;
            while (parentNode) {
                if (parentNode.nodeName.toLowerCase() === 'head') {
                    isInsideHead = true;
                    break;
                }
                parentNode = parentNode.parentNode;
            }
            if (isInsideHead) {
                discriminatorFragments.push('head');
            } else {
                discriminatorFragments.push('body');
            }
            if (relation.conditionalComments) {
                Array.prototype.push.apply(discriminatorFragments, _.map(relation.conditionalComments, 'nodeValue'));
            }
            if (relation.node && relation.node.hasAttribute && relation.node.hasAttribute('bundle')) {
                discriminatorFragments.push(relation.node.getAttribute('bundle'));
            }
            if (relation.type === 'HtmlStyle') {
                discriminatorFragments.push(relation.node.getAttribute('media') || 'all');
                for (i = 0 ; i < relation.node.attributes.length ; i += 1) {
                    attribute = relation.node.attributes[i];
                    if (attribute.name !== 'charset' &&
                        attribute.name !== 'media' &&
                        attribute.name !== 'bundle' &&
                        (attribute.name !== 'rel' || attribute.value !== 'stylesheet') &&
                        (attribute.name !== 'href' || relation.node.nodeName.toLowerCase() !== 'link') &&
                        (attribute.name !== 'type' || attribute.value !== 'text/css' || !relation.to || relation.to.type !== 'Css')) {
                        return 'nobundle';
                    }
                }
            } else if (relation.type === 'HtmlScript') {
                if (relation.to.strict) {
                    discriminatorFragments.push('strict');
                    var warning = new Error('Global "use strict"-directive. Splitting into multiple bundles to avoid side effects.');
                    warning.asset = relation.to;
                    assetGraph.emit('info', warning);
                }
                if (relation.node.getAttribute('defer') === 'defer') {
                    discriminatorFragments.push('defer');
                }
                if (relation.node.getAttribute('async') === 'async') {
                    discriminatorFragments.push('async');
                }
                for (i = 0 ; i < relation.node.attributes.length ; i += 1) {
                    attribute = relation.node.attributes[i];
                    if (attribute.name !== 'charset' &&
                        attribute.name !== 'src' &&
                        attribute.name !== 'bundle' &&
                        (attribute.name !== 'defer' || attribute.value !== 'defer') &&
                        (attribute.name !== 'async' || attribute.value !== 'async') &&
                        (attribute.name !== 'type' || attribute.value !== 'text/javascript' || !relation.to || relation.to.type !== 'JavaScript')) {

                        return 'nobundle';
                    }
                }
            }
            return discriminatorFragments.join(':');
        }

        // Reuses the parse trees of existing assets, so be careful!
        function makeBundle(assetsToBundle, incomingType) {
            if (assetsToBundle.length === 0) {
                throw new Error('makeBundle: Bundle must contain at least one asset');
            } else if (assetsToBundle.length === 1) {
                // Shortcut
                return [assetsToBundle[0]];
            }

            var type = assetsToBundle[0].type,
                constructorOptions = {
                    lastKnownByteLength: assetsToBundle.reduce(function (sumOfLastKnownByteLengths, asset) {
                        return sumOfLastKnownByteLengths + asset.lastKnownByteLength;
                    }, 0)
                };

            if (type === 'JavaScript') {
                constructorOptions.parseTree = { type: 'Program', body: [] };
                assetsToBundle.forEach(function (asset, i) {
                    assetGraph.findRelations({from: asset, type: 'JavaScriptInclude'}, true).forEach(function (relation) {
                        if (relation.parentNode === asset.parseTree) {
                            // This INCLUDE relation is a top level statement, update its .parentNode property to point at
                            // the top level statements array of the bundle:
                            relation.parentNode = constructorOptions.parseTree;
                        }
                    });

                    assetGraph.findRelations({from: asset, type: 'JavaScriptSourceMappingUrl'}, true).forEach(function (relation) {
                        if (relation.to.isAsset) {
                            assetGraph.removeAsset(relation.to);
                        }
                        relation.detach();
                    });

                    // Append asset to new bundle
                    Array.prototype.push.apply(constructorOptions.parseTree.body, asset.parseTree.body);
                });
            } else {
                // type === 'Css'
                constructorOptions.parseTree = postcss.parse('');
                // Make sure that all @import rules go at the top of the bundle:
                var importRules = [];
                assetsToBundle.forEach(function (asset) {
                    var topLevelNodes = asset.parseTree.nodes;
                    for (var i = 0 ; i < topLevelNodes.length ; i += 1) {
                        var topLevelNode = topLevelNodes[i];
                        topLevelNode.parent = constructorOptions.parseTree;
                        if (topLevelNode.type === 'atrule' && topLevelNode.name === 'import') {
                            importRules.push(topLevelNode);
                            topLevelNodes.splice(i, 1);
                            i -= 1;
                        }
                    }
                    Array.prototype.push.apply(constructorOptions.parseTree.nodes, topLevelNodes);
                });
                if (importRules.length > 0) {
                    Array.prototype.unshift.apply(constructorOptions.parseTree.nodes, importRules);
                }
            }

            var bundleAsset = new AssetGraph[type](constructorOptions);

            bundleAsset.url = urlTools.resolveUrl(assetGraph.root, 'bundle-' + bundleAsset.id + bundleAsset.extension);
            bundleAsset._outgoingRelations = assetGraph.findRelations({from: assetsToBundle}, true);
            bundleAsset._outgoingRelations.forEach(function (outgoingRelation) {
                outgoingRelation.remove();
                outgoingRelation.from = bundleAsset;
            });

            var seenReferringAssets = {},
                incomingRelations = assetGraph.findRelations({type: incomingType, to: assetsToBundle}),
                // Point at the bundled asset with a root-relative href if at least one of the relations
                // being bundled have a more specific hrefType than 'relative':
                bundleRelationHrefType = incomingRelations.some(function (incomingRelation) {
                    return incomingRelation.hrefType !== 'relative';
                }) ? 'rootRelative' : 'relative';

            incomingRelations.forEach(function (incomingRelation) {
                if (!seenReferringAssets[incomingRelation.from.id]) {
                    var bundleRelation = new AssetGraph[incomingType]({
                        hrefType: bundleRelationHrefType,
                        to: bundleAsset
                    });
                    bundleRelation.attach(incomingRelation.from, 'before', incomingRelation);
                    if (incomingType === 'HtmlStyle') {
                        var media = incomingRelation.node.getAttribute('media');
                        if (media && media !== 'all') {
                            bundleRelation.node.setAttribute('media', media);
                            bundleRelation.from.markDirty();
                        }
                    }
                    seenReferringAssets[incomingRelation.from.id] = true;
                }
                incomingRelation.detach();
            });

            assetGraph.addAsset(bundleAsset);

            assetsToBundle.forEach(function (asset) {
                if (assetGraph.findRelations({to: asset}).length === 0) {
                    assetGraph.removeAsset(asset);
                }
            });
            return bundleAsset;
        }

        var bundleStrategyByName = {};

        // Quick and dirty bundling strategy that gets you down to one <script> and one <link rel='stylesheet'>
        // per document, but doesn't do any cross-page optimization.
        bundleStrategyByName.oneBundlePerIncludingAsset = function () {
            var assetsToBundleById = {},
                bundleAssets = [],
                relationsByIncludingAsset = {};

            assetGraph.findRelations(queryObj).forEach(function (relation) {
                assetsToBundleById[relation.to.id] = relation.to; // Means not in a bundle yet
                (relationsByIncludingAsset[relation.from.id] = relationsByIncludingAsset[relation.from.id] || []).push(relation);
            });

            Object.keys(relationsByIncludingAsset).forEach(function (includingAssetId) {
                var relationsToBundle = relationsByIncludingAsset[includingAssetId];

                _.uniq(_.map(relationsToBundle, 'type')).forEach(function (relationType) {
                    var currentBundle = [],
                        bundleDiscriminator,
                        relationsOfTypeToBundle = relationsToBundle.filter(function (relation) {
                            return relation.type === relationType;
                        });

                    function flushBundle() {
                        if (currentBundle.length > 0) {
                            bundleAssets.push(makeBundle(currentBundle, relationType)); // FIXME
                            currentBundle = [];
                        }
                    }
                    assetGraph.findRelations(assetGraph.constructor.query.or({type: relationType}, {type: 'HtmlConditionalComment'}), true).forEach(function (outgoingRelation) {
                        if (outgoingRelation.type === 'HtmlConditionalComment') {
                            if (assetGraph.findRelations({from: outgoingRelation.to, type: relationType}, true).length > 0) {
                                flushBundle();
                            }
                        } else if (relationsOfTypeToBundle.indexOf(outgoingRelation) !== -1) {
                            // Make sure that we don't bundle HtmlStyles with different media attributes together etc.:
                            var discriminator = getDiscriminatorForRelation(outgoingRelation);
                            if (bundleDiscriminator && (discriminator === 'nobundle' || bundleDiscriminator === 'nobundle' || discriminator !== bundleDiscriminator)) {
                                flushBundle();
                            }
                            bundleDiscriminator = discriminator;
                            if (assetGraph.findRelations({to: outgoingRelation.to}).length > 1) {
                                currentBundle.push(outgoingRelation.to.clone(outgoingRelation));
                            } else {
                                currentBundle.push(outgoingRelation.to);
                            }
                        } else {
                            flushBundle();
                        }
                    });
                    flushBundle();
                });
            });
            return bundleAssets;
        };

        // Cross-page optimizing bundling strategy that never puts the same chunk in multiple bundles, but still tries
        // to create as few bundles as possible. Also preserves inclusion order.
        bundleStrategyByName.sharedBundles = function () {
            var assetIndex = {},
                seenIncludingAssets = {},
                bundles = [],
                relationsByIncludingAsset = {};

            assetGraph.findRelations(queryObj).forEach(function (relation) {
                assetIndex[relation.to.id] = null; // Means not in a bundle yet
                seenIncludingAssets[relation.from.id] = relation.from;
                (relationsByIncludingAsset[relation.from.id] = relationsByIncludingAsset[relation.from.id] || []).push(relation);
            });

            function splitBundle(bundle, index) {
                var newBundle = bundle.splice(index);
                newBundle._relationType = bundle._relationType;
                newBundle.forEach(function (asset) {
                    assetIndex[asset.id] = newBundle;
                });
                if (newBundle.length > 0) {
                    bundles.push(newBundle);
                }
                return newBundle;
            }

            _.values(seenIncludingAssets).forEach(function (includingAsset) {
                var relationsToBundle = relationsByIncludingAsset[includingAsset.id];

                _.uniq(_.map(relationsToBundle, 'type')).forEach(function (relationType) {
                    var outgoingRelations = assetGraph.findRelations({from: includingAsset, type: [relationType, 'HtmlConditionalComment']}, true), // includeUnresolved
                        previousBundle,
                        bundleDiscriminator,
                        canAppendToPreviousBundle = false,
                        previousBundleIndex;

                    outgoingRelations.forEach(function (outgoingRelation) {
                        if (outgoingRelation.type === 'HtmlConditionalComment') {
                            if (assetGraph.findRelations({from: outgoingRelation.to, type: relationType}).length > 0) {
                                canAppendToPreviousBundle = false;
                            }
                            return;
                        }

                        // Make sure that we don't bundle HtmlStyles with different media attributes together etc.:
                        var discriminator = getDiscriminatorForRelation(outgoingRelation);
                        if (bundleDiscriminator && (discriminator === 'nobundle' || bundleDiscriminator === 'nobundle' || discriminator !== bundleDiscriminator)) {
                            canAppendToPreviousBundle = false;
                        }
                        bundleDiscriminator = discriminator;

                        var existingBundle = assetIndex[outgoingRelation.to.id];
                        if (existingBundle === null) {
                            // Not bundled yet, append to previousBundle if possible, else create a new one
                            if (canAppendToPreviousBundle) {
                                previousBundle.push(outgoingRelation.to);
                                previousBundleIndex = previousBundle.length - 1;
                            } else {
                                if (previousBundle && previousBundleIndex !== previousBundle.length - 1) {
                                    splitBundle(previousBundle, previousBundleIndex + 1);
                                }
                                previousBundle = [outgoingRelation.to];
                                previousBundle._relationType = relationType;
                                previousBundleIndex = 0;
                                bundles.push(previousBundle);
                                canAppendToPreviousBundle = true;
                            }
                            assetIndex[outgoingRelation.to.id] = previousBundle;
                        } else if (existingBundle) {
                            // Already in another bundle
                            canAppendToPreviousBundle = false;
                            var indexInExistingBundle = existingBundle.indexOf(outgoingRelation.to);
                            if (previousBundle && existingBundle === previousBundle) {
                                if (indexInExistingBundle === previousBundleIndex + 1) {
                                    previousBundleIndex = indexInExistingBundle;
                                } else {
                                    splitBundle(previousBundle, indexInExistingBundle + 1);
                                    existingBundle = assetIndex[outgoingRelation.to.id];
                                    indexInExistingBundle = existingBundle.indexOf(outgoingRelation.to);
                                    if (indexInExistingBundle !== 0) {
                                        existingBundle = splitBundle(existingBundle, indexInExistingBundle);
                                    }
                                    previousBundle = existingBundle;
                                    previousBundleIndex = 0;
                                }
                            } else {
                                if (previousBundle && previousBundleIndex !== (previousBundle.length - 1)) {
                                    splitBundle(previousBundle, previousBundleIndex + 1);
                                }
                                if (indexInExistingBundle !== 0) {
                                    existingBundle = splitBundle(existingBundle, indexInExistingBundle);
                                }
                                previousBundle = existingBundle;
                                previousBundleIndex = 0;
                            }
                        } else {
                            // The relation doesn't point at an asset matched by queryObj
                            previousBundle = null;
                            canAppendToPreviousBundle = false;
                        }
                    });
                    // No more outgoing relations for this asset, make sure that the asset that was bundled
                    // last is at the last position in its bundle:
                    if (previousBundle && previousBundleIndex !== previousBundle.length - 1) {
                        splitBundle(previousBundle, previousBundleIndex + 1);
                    }

                });
            });

            return bundles.map(function (bundle) {
                makeBundle(bundle, bundle._relationType);
            });
        };

        var bundleAssets = bundleStrategyByName[bundleStrategyName]();
        assetGraph.recomputeBaseAssets();
        bundleAssets.forEach(function (bundleAsset) {
            assetGraph.findRelations({to: bundleAsset}).forEach(function (incomingRelation) {
                incomingRelation.refreshHref();
            });
            assetGraph.findRelations({from: bundleAsset}).forEach(function (outgoingRelation) {
                outgoingRelation.refreshHref();
            });
        });
    };
};
