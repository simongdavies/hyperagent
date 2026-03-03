fn main() {
    use regex_automata::meta::Regex;
    let source = r#"
        function handler(event) {
            const buf = Buffer.from("hello");
            return buf;
        }
    "#;

    let pattern = r"\bBuffer\b";
    println!("Testing pattern: {}", pattern);
    println!("Source: {:?}", source);

    match Regex::new(pattern) {
        Ok(re) => {
            println!("Regex compiled OK");
            let matches = re.is_match(source.as_bytes());
            println!("Matches: {}", matches);
            if let Some(m) = re.find(source.as_bytes()) {
                println!("Found at: {:?}", m);
            }
        }
        Err(e) => {
            println!("Regex FAILED: {:?}", e);
        }
    }

    // Try simpler pattern
    let simple_pattern = "Buffer";
    println!("\nTesting simple pattern: {}", simple_pattern);
    match Regex::new(simple_pattern) {
        Ok(re) => {
            println!("Regex compiled OK");
            let matches = re.is_match(source.as_bytes());
            println!("Matches: {}", matches);
        }
        Err(e) => {
            println!("Regex FAILED: {:?}", e);
        }
    }
}
