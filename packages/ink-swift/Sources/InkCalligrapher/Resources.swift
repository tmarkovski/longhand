import Foundation

/// The weights committed with the repo (packages/ink-calligrapher/assets),
/// bundled into this target as a resource — consumers who add the package
/// from git load the model with no downloads or file wrangling:
///
///     let model = try CalligrapherModel(assets: parseCalligrapherWeights(bundledCalligrapherWeights()))
public func bundledCalligrapherWeights() throws -> Data {
    guard let url = Bundle.module.url(forResource: "calligrapher-v1", withExtension: "bin") else {
        throw CalligrapherError.missingBundledWeights
    }
    return try Data(contentsOf: url)
}
