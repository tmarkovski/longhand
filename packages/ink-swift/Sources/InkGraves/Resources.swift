import Foundation

/// The weights committed with the repo (packages/ink-graves/assets),
/// bundled into this target as a resource — consumers who add the package
/// from git load the model with no downloads or file wrangling:
///
///     let model = try GravesModel(assets: parseModelAssets(bundledGravesWeights()))
public func bundledGravesWeights() throws -> Data {
    guard let url = Bundle.module.url(forResource: "graves-v2", withExtension: "bin") else {
        throw GravesError.missingBundledWeights
    }
    return try Data(contentsOf: url)
}
