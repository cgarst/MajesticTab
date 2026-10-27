public func trigger<GenericIntoRustString: IntoRustString>(_ event: GenericIntoRustString, _ payload: GenericIntoRustString) throws -> () {
    try { let val = __swift_bridge__$trigger({ let rustString = event.intoRustString(); rustString.isOwned = false; return rustString.ptr }(), { let rustString = payload.intoRustString(); rustString.isOwned = false; return rustString.ptr }()); switch val.tag { case __swift_bridge__$ResultVoidAndFFIResult$ResultOk: return case __swift_bridge__$ResultVoidAndFFIResult$ResultErr: throw val.payload.err.intoSwiftRepr() default: fatalError() } }()
}
@_cdecl("__swift_bridge__$IapPlugin$init_plugin")
func __swift_bridge__IapPlugin_init_plugin () -> UnsafeMutableRawPointer {
    Unmanaged.passRetained(IapPlugin()).toOpaque()
}

@_cdecl("__swift_bridge__$IapPlugin$getProducts")
func __swift_bridge__IapPlugin_getProducts (_ callbackWrapper: UnsafeMutableRawPointer, _ onSuccess: @escaping @convention(c) (UnsafeMutableRawPointer, UnsafeMutableRawPointer) -> Void, _ onError: @escaping @convention(c) (UnsafeMutableRawPointer, __swift_bridge__$FFIResult) -> Void, _ this: UnsafeMutableRawPointer, _ productIds: UnsafeMutableRawPointer, _ productType: UnsafeMutableRawPointer) {
    let __captures = __private__UncheckedSendable((callbackWrapper, onSuccess, onError, this))
    Task {
        let (callbackWrapper, onSuccess, onError, this) = __captures.value
        do {
            let result = try await Unmanaged<IapPlugin>.fromOpaque(this).takeUnretainedValue().getProducts(productIds: RustVec(ptr: productIds), productType: RustString(ptr: productType))
            onSuccess(callbackWrapper, { let rustString = result.intoRustString(); rustString.isOwned = false; return rustString.ptr }())
        } catch let error as FFIResult {
            onError(callbackWrapper, error.intoFfiRepr())
        }
    }
}
func __swift_bridge__IapPlugin_getProducts__TypedThrowsCheck(_ this: UnsafeMutableRawPointer, _ productIds: UnsafeMutableRawPointer, _ productType: UnsafeMutableRawPointer, _: FFIResult.Type) async throws(FFIResult) {
    _ = try await Unmanaged<IapPlugin>.fromOpaque(this).takeUnretainedValue().getProducts(productIds: RustVec(ptr: productIds), productType: RustString(ptr: productType))
}

@_cdecl("__swift_bridge__$IapPlugin$purchase")
func __swift_bridge__IapPlugin_purchase (_ callbackWrapper: UnsafeMutableRawPointer, _ onSuccess: @escaping @convention(c) (UnsafeMutableRawPointer, UnsafeMutableRawPointer) -> Void, _ onError: @escaping @convention(c) (UnsafeMutableRawPointer, __swift_bridge__$FFIResult) -> Void, _ this: UnsafeMutableRawPointer, _ productId: UnsafeMutableRawPointer, _ productType: UnsafeMutableRawPointer, _ offerToken: UnsafeMutableRawPointer?) {
    let __captures = __private__UncheckedSendable((callbackWrapper, onSuccess, onError, this))
    Task {
        let (callbackWrapper, onSuccess, onError, this) = __captures.value
        do {
            let result = try await Unmanaged<IapPlugin>.fromOpaque(this).takeUnretainedValue().purchase(productId: RustString(ptr: productId), productType: RustString(ptr: productType), offerToken: { let val = offerToken; if val != nil { return RustString(ptr: val!) } else { return nil } }())
            onSuccess(callbackWrapper, { let rustString = result.intoRustString(); rustString.isOwned = false; return rustString.ptr }())
        } catch let error as FFIResult {
            onError(callbackWrapper, error.intoFfiRepr())
        }
    }
}
func __swift_bridge__IapPlugin_purchase__TypedThrowsCheck(_ this: UnsafeMutableRawPointer, _ productId: UnsafeMutableRawPointer, _ productType: UnsafeMutableRawPointer, _ offerToken: UnsafeMutableRawPointer?, _: FFIResult.Type) async throws(FFIResult) {
    _ = try await Unmanaged<IapPlugin>.fromOpaque(this).takeUnretainedValue().purchase(productId: RustString(ptr: productId), productType: RustString(ptr: productType), offerToken: { let val = offerToken; if val != nil { return RustString(ptr: val!) } else { return nil } }())
}

@_cdecl("__swift_bridge__$IapPlugin$restorePurchases")
func __swift_bridge__IapPlugin_restorePurchases (_ callbackWrapper: UnsafeMutableRawPointer, _ onSuccess: @escaping @convention(c) (UnsafeMutableRawPointer, UnsafeMutableRawPointer) -> Void, _ onError: @escaping @convention(c) (UnsafeMutableRawPointer, __swift_bridge__$FFIResult) -> Void, _ this: UnsafeMutableRawPointer, _ productType: UnsafeMutableRawPointer) {
    let __captures = __private__UncheckedSendable((callbackWrapper, onSuccess, onError, this))
    Task {
        let (callbackWrapper, onSuccess, onError, this) = __captures.value
        do {
            let result = try await Unmanaged<IapPlugin>.fromOpaque(this).takeUnretainedValue().restorePurchases(productType: RustString(ptr: productType))
            onSuccess(callbackWrapper, { let rustString = result.intoRustString(); rustString.isOwned = false; return rustString.ptr }())
        } catch let error as FFIResult {
            onError(callbackWrapper, error.intoFfiRepr())
        }
    }
}
func __swift_bridge__IapPlugin_restorePurchases__TypedThrowsCheck(_ this: UnsafeMutableRawPointer, _ productType: UnsafeMutableRawPointer, _: FFIResult.Type) async throws(FFIResult) {
    _ = try await Unmanaged<IapPlugin>.fromOpaque(this).takeUnretainedValue().restorePurchases(productType: RustString(ptr: productType))
}

@_cdecl("__swift_bridge__$IapPlugin$getProductStatus")
func __swift_bridge__IapPlugin_getProductStatus (_ callbackWrapper: UnsafeMutableRawPointer, _ onSuccess: @escaping @convention(c) (UnsafeMutableRawPointer, UnsafeMutableRawPointer) -> Void, _ onError: @escaping @convention(c) (UnsafeMutableRawPointer, __swift_bridge__$FFIResult) -> Void, _ this: UnsafeMutableRawPointer, _ productId: UnsafeMutableRawPointer, _ productType: UnsafeMutableRawPointer) {
    let __captures = __private__UncheckedSendable((callbackWrapper, onSuccess, onError, this))
    Task {
        let (callbackWrapper, onSuccess, onError, this) = __captures.value
        do {
            let result = try await Unmanaged<IapPlugin>.fromOpaque(this).takeUnretainedValue().getProductStatus(productId: RustString(ptr: productId), productType: RustString(ptr: productType))
            onSuccess(callbackWrapper, { let rustString = result.intoRustString(); rustString.isOwned = false; return rustString.ptr }())
        } catch let error as FFIResult {
            onError(callbackWrapper, error.intoFfiRepr())
        }
    }
}
func __swift_bridge__IapPlugin_getProductStatus__TypedThrowsCheck(_ this: UnsafeMutableRawPointer, _ productId: UnsafeMutableRawPointer, _ productType: UnsafeMutableRawPointer, _: FFIResult.Type) async throws(FFIResult) {
    _ = try await Unmanaged<IapPlugin>.fromOpaque(this).takeUnretainedValue().getProductStatus(productId: RustString(ptr: productId), productType: RustString(ptr: productType))
}

public enum FFIResult {
    case Err(RustString)
}
extension FFIResult {
    func intoFfiRepr() -> __swift_bridge__$FFIResult {
        switch self {
            case FFIResult.Err(let _0):
                return __swift_bridge__$FFIResult(tag: __swift_bridge__$FFIResult$Err, payload: __swift_bridge__$FFIResultFields(Err: __swift_bridge__$FFIResult$FieldOfErr(_0: { let rustString = _0.intoRustString(); rustString.isOwned = false; return rustString.ptr }())))
        }
    }
}
extension __swift_bridge__$FFIResult {
    func intoSwiftRepr() -> FFIResult {
        switch self.tag {
            case __swift_bridge__$FFIResult$Err:
                return FFIResult.Err(RustString(ptr: self.payload.Err._0))
            default:
                fatalError("Unreachable")
        }
    }
}
extension __swift_bridge__$Option$FFIResult {
    @inline(__always)
    func intoSwiftRepr() -> Optional<FFIResult> {
        if self.is_some {
            return self.val.intoSwiftRepr()
        } else {
            return nil
        }
    }
    @inline(__always)
    static func fromSwiftRepr(_ val: Optional<FFIResult>) -> __swift_bridge__$Option$FFIResult {
        if let v = val {
            return __swift_bridge__$Option$FFIResult(is_some: true, val: v.intoFfiRepr())
        } else {
            return __swift_bridge__$Option$FFIResult(is_some: false, val: __swift_bridge__$FFIResult())
        }
    }
}

@_cdecl("__swift_bridge__$IapPlugin$_free")
func __swift_bridge__IapPlugin__free (ptr: UnsafeMutableRawPointer) {
    let _ = Unmanaged<IapPlugin>.fromOpaque(ptr).takeRetainedValue()
}
protocol __swift_bridge__IsSendable: Sendable {}
extension IapPlugin: __swift_bridge__IsSendable {}


